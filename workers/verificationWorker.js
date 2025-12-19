// server/workers/verificationWorker.js
const { Worker } = require('bullmq');
const { PrismaClient } = require('@prisma/client');
const { Expo } = require('expo-server-sdk');
const crypto = require('crypto');
const Redis = require('ioredis');
const { redisOptions } = require('../config/redis');

// 🔥 FIX: Безопасное подключение. Если настроек нет — redis будет null.
const redis = redisOptions ? new Redis(redisOptions) : null;

// Импорты сервисов
const VideoManager = require('../services/video/VideoManager');
const { cleanupFile } = require('../services/videoProcessor');
const { transcribeAudio, verifyClaim, analyzeContentType } = require('../services/aiService');
const ClaimExtractor = require('../services/claimExtractor');

const prisma = new PrismaClient();
const expo = new Expo();

// Кэш на 24 часа
const CACHE_TTL = 86400;

function normalizeVerdict(verdict) {
  if (!verdict) return 'UNCERTAIN';
  const v = verdict.toLowerCase();
  if (v.includes('misleading') || v.includes('partial') || v.includes('mixed')) return 'DISPUTED';
  if (v.includes('false') || v.includes('fake') || v.includes('incorrect') || v.includes('contradicted')) return 'CONTRADICTED';
  if (v.includes('true') || v.includes('accurate') || v.includes('correct') || v.includes('confirmed')) return 'CONFIRMED';
  return 'UNCERTAIN';
}

async function processVerification(job) {
  const { type, content, timestamp, pushToken } = job.data;
  console.log(`[Worker] ⚙️ Processing job ${job.id} (${type})`);
  await job.updateProgress(5);

  const contentHash = crypto.createHash('md5').update(content.trim()).digest('hex');
  const cacheKey = `result:${contentHash}`;
  let audioFile = null;
  let cleanupCallback = null;

  try {
    // ---------------------------------------------------------
    // УРОВЕНЬ 1: REDIS (Мгновенная память - RAM)
    // ---------------------------------------------------------
    // 🔥 FIX: Проверяем, есть ли Redis перед чтением
    if (redis) {
        const cachedRedis = await redis.get(cacheKey);
        if (cachedRedis) {
            console.log('[Worker] ⚡ REDIS HIT (Fastest)');
            const res = JSON.parse(cachedRedis);
            await sendPush(pushToken, res.verdict, res.dbId);
            return res;
        }
    }

    // ---------------------------------------------------------
    // УРОВЕНЬ 2: PRISMA (Долгосрочная память - Disk)
    // ---------------------------------------------------------
    const existingCheck = await prisma.check.findFirst({
        where: { content: content },
        orderBy: { createdAt: 'desc' }
    });

    if (existingCheck) {
        console.log('[Worker] 📚 DB HIT (Historical Data)');
        const dbResult = {
            verdict: existingCheck.verdict,
            confidence: existingCheck.confidence,
            summary: existingCheck.summary,
            ai_details: { model: existingCheck.aiModel },
            key_claim: existingCheck.keyClaim,
            sources: existingCheck.sources ? JSON.parse(existingCheck.sources) : [],
            dbId: existingCheck.id
        };
        
        // 🔥 FIX: Пишем в кэш только если Redis доступен
        if (redis) {
            await redis.set(cacheKey, JSON.stringify(dbResult), 'EX', CACHE_TTL);
        }
        
        await sendPush(pushToken, dbResult.verdict, existingCheck.id);
        return dbResult;
    }

    // ---------------------------------------------------------
    // УРОВЕНЬ 3: ПОЛНЫЙ АНАЛИЗ (AI)
    // ---------------------------------------------------------
    let analysisText = content;

    // 1. Получение текста
    if (type === 'video') {
       try {
           console.log('[Worker] 🎬 Starting VideoManager...');
           const result = await VideoManager.process(content);
           
           if (result.type === 'text') {
               console.log('[Worker] 📄 Subtitles extracted directly');
               analysisText = result.content;
           } else if (result.type === 'audio') {
               console.log(`[Worker] 🎧 Audio downloaded: ${result.filePath}`);
               audioFile = result.filePath;
               analysisText = await transcribeAudio(audioFile);
           }
           
           if (result.cleanup) cleanupCallback = result.cleanup;
       } catch (err) {
           console.error('[Worker] Video processing died:', err.message);
           throw new Error("Не удалось скачать видео. Возможно, приватный доступ или блокировка.");
       }
    }

    if (!analysisText || analysisText.length < 10) {
        throw new Error("Не удалось получить текст для анализа");
    }
    
    // 2. Фейс-контроль (Gatekeeper)
    console.log('[Worker] 🛡️ Running Gatekeeper...');
    const classification = await analyzeContentType(analysisText);
    
    let result;

    if (classification.type !== 'claims') {
        console.log(`[Worker] 🛑 Skipping fact-check. Detected: ${classification.type}`);
        result = {
            verdict: 'UNCERTAIN', 
            confidence: 1.0,
            sources: [],
            key_claim: "Контент не требует проверки",
            summary: classification.summary || "Это развлекательный контент.",
            ai_details: { model: "Gatekeeper" }
        };
        if (classification.type === 'music') {
            result.summary = `🎵 Это музыкальный трек: "${classification.title || 'Неизвестно'}".\n\nТекст песни не содержит фактов.`;
        }
    } else {
        console.log('[Worker] ✅ Facts detected. Verifying...');
        const extraction = ClaimExtractor.extract(analysisText);
        const promptText = (extraction && extraction.confidence > 0.4) ? extraction.bestClaim : analysisText;
        
        if (promptText !== analysisText) {
             console.log(`[Worker] Key claim: "${promptText.substring(0, 50)}..."`);
        }

        result = await verifyClaim(promptText);
        result.verdict = normalizeVerdict(result.verdict);
        result.key_claim = promptText;
    }

    // 3. Сохранение
    await prisma.user.upsert({ where: { id: "anon" }, update: {}, create: { id: "anon", email: "anon@truthcheck.ai" } });
    
    const startTime = timestamp || Date.now();
    const duration = Date.now() - startTime;
    
    const savedCheck = await prisma.check.create({
        data: {
            userId: "anon",
            type: type,
            content: content,
            verdict: result.verdict,
            confidence: result.confidence,
            summary: result.summary,
            aiModel: result.ai_details?.model || "Hybrid",
            durationMs: duration,
            keyClaim: result.key_claim || null,
            sources: JSON.stringify(result.sources || []) 
        }
    });
    result.dbId = savedCheck.id;

    // 4. Кэш в Redis
    // 🔥 FIX: Безопасная запись в кэш
    if (redis) {
        await redis.set(cacheKey, JSON.stringify(result), 'EX', CACHE_TTL);
        console.log('[Worker] 💾 Result cached for 24h');
    }

    await sendPush(pushToken, result.verdict, savedCheck.id);
    await job.updateProgress(100);

    return result;

  } catch (error) {
    console.error(`[Worker] ❌ Failed: ${error.message}`);
    throw error;
  } finally {
    // Очистка файлов
    if (cleanupCallback) {
        try { cleanupCallback(); } catch(e) { console.error('Cleanup error:', e.message); }
    } else if (audioFile) {
        cleanupFile(audioFile);
    }
  }
}

async function sendPush(token, verdict, id) {
    if (token && Expo.isExpoPushToken(token)) {
        const statusEmoji = verdict === 'CONFIRMED' ? '✅' : verdict === 'CONTRADICTED' ? '❌' : '⚠️';
        const messages = [{
          to: token, sound: 'default', title: `${statusEmoji} Проверка завершена`,
          body: `Вердикт: ${verdict}.\nНажмите для отчета.`, data: { resultId: id },
        }];
        const chunks = expo.chunkPushNotifications(messages);
        for (const chunk of chunks) {
            try { await expo.sendPushNotificationsAsync(chunk); } catch (e) { console.error('Push Error:', e); }
        }
    }
}

const initWorker = () => {
  console.log('[Worker] 🚀 Verification Worker Initialized');
  const worker = new Worker('verification-queue', processVerification, {
    connection: redisOptions,
    concurrency: 2,
  });
  worker.on('failed', (job, err) => console.error(`[Worker] 💀 Job ${job.id} failed: ${err.message}`));
  return worker;
};

module.exports = { initWorker };