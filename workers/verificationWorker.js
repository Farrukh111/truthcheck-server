const { Worker } = require('bullmq');
const { PrismaClient } = require('@prisma/client');
const { Expo } = require('expo-server-sdk');
const crypto = require('crypto');
const Redis = require('ioredis');
const { redisOptions } = require('../config/redis');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// 🔥 FIX: Безопасное подключение. Если настроек нет — redis будет null.
const redis = redisOptions ? new Redis(redisOptions) : null;

// Импорты сервисов
// Мы используем ytDlpProvider напрямую для контроля пайплайна
const ytDlp = require('../services/video/providers/YtDlpProvider'); 
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
  const verificationId = job.id; // ID задачи для имени файла
  console.log(`[Worker] ⚙️ Processing job ${verificationId} (${type})`);
  await job.updateProgress(5);

  const contentHash = crypto.createHash('md5').update(content.trim()).digest('hex');
  const cacheKey = `result:${contentHash}`;
  
  // Переменные для путей файлов (чтобы удалить их в finally)
  let rawAudioFile = null;
  let cleanAudioFile = null;

  try {
    // ---------------------------------------------------------
    // УРОВЕНЬ 1: REDIS (Мгновенная память - RAM)
    // ---------------------------------------------------------
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
        
        if (redis) {
            await redis.set(cacheKey, JSON.stringify(dbResult), 'EX', CACHE_TTL);
        }
        
        await sendPush(pushToken, dbResult.verdict, existingCheck.id);
        return dbResult;
    }

    // ---------------------------------------------------------
    // УРОВЕНЬ 3: ПОЛНЫЙ АНАЛИЗ (AI + VAD PIPELINE)
    // ---------------------------------------------------------
    let analysisText = content;

    // 1. Обработка ВИДЕО (Smart Pipeline)
    if (type === 'video') {
       try {
           const tempId = `video_${verificationId}`;

           // ШАГ A: Проверка длительности (Fail Fast)
           console.log('[Worker] ⏱️ Checking duration...');
           const duration = await ytDlp.getVideoDuration(content);
           
           if (duration > 180) { // Лимит 3 минуты (180 сек)
               throw new Error("VIDEO_TOO_LONG_LIMIT_3MIN");
           }

           // ШАГ B: Скачивание (Smart Extraction)
           console.log('[Worker] ⬇️ Downloading audio segment...');
           // Качаем максимум 180 сек
           rawAudioFile = await ytDlp.downloadAudioSegment(content, tempId, 180);
           await job.updateProgress(20);

           // ШАГ C: VAD (Очистка от музыки/тишины)
           console.log('[Worker] 🧹 Cleaning audio (VAD)...');
           cleanAudioFile = rawAudioFile.replace('.wav', '_clean.wav');

           // Запускаем Python скрипт
           await new Promise((resolve, reject) => {
               // Путь к скрипту относительно воркера. 
               // Предполагается структура: server/workers/verificationWorker.js -> server/services/vad/clean_audio.py
               const scriptPath = path.resolve(__dirname, '../services/vad/clean_audio.py');
               
               const python = spawn('python', [scriptPath, rawAudioFile, cleanAudioFile]);
               
               let stderr = '';
               python.stderr.on('data', (d) => { stderr += d.toString(); });

               python.on('close', (code) => {
                   if (code === 0) resolve();
                   else {
                       console.warn(`[VAD Warning] Script failed/empty: ${stderr}`);
                       // Если VAD не сработал (например, нет голоса), используем оригинал или падаем
                       // Для надежности: если VAD упал, пробуем оригинал, но помечаем риск
                       reject(new Error(`VAD processing failed: ${stderr}`));
                   }
               });
           });
           
           await job.updateProgress(40);

           // ШАГ D: Транскрибация (Whisper)
           console.log('[Worker] 🗣️ Transcribing clean audio...');
           // Отправляем ОЧИЩЕННЫЙ файл
           analysisText = await transcribeAudio(cleanAudioFile);

       } catch (err) {
           console.error('[Worker] Video processing error:', err.message);
           
           // Специальная обработка ошибки лимита
           if (err.message === "VIDEO_TOO_LONG_LIMIT_3MIN") {
               return {
                   status: 'failed',
                   verdict: 'UNCERTAIN',
                   summary: 'Видео слишком длинное. В демо-версии поддерживаются Shorts/Reels/TikTok до 3 минут.',
                   error: 'LIMIT_EXCEEDED'
               };
           }
           
           throw new Error("Ошибка обработки видео: " + err.message);
       }
    }

    if (!analysisText || analysisText.length < 10) {
        throw new Error("Не удалось распознать речь или текст слишком короткий.");
    }
    
    await job.updateProgress(60);

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
    
    const startTs = timestamp || Date.now();
    const taskDuration = Date.now() - startTs;
    
    const savedCheck = await prisma.check.create({
        data: {
            userId: "anon",
            type: type,
            content: content,
            verdict: result.verdict,
            confidence: result.confidence,
            summary: result.summary,
            aiModel: result.ai_details?.model || "Hybrid",
            durationMs: taskDuration,
            keyClaim: result.key_claim || null,
            sources: JSON.stringify(result.sources || []) 
        }
    });
    result.dbId = savedCheck.id;

    // 4. Кэш в Redis
    if (redis) {
        await redis.set(cacheKey, JSON.stringify(result), 'EX', CACHE_TTL);
        console.log('[Worker] 💾 Result cached for 24h');
    }

    await sendPush(pushToken, result.verdict, savedCheck.id);
    await job.updateProgress(100);

    return result;

  } catch (error) {
    console.error(`[Worker] ❌ Failed: ${error.message}`);
    // Если это наша кастомная ошибка - возвращаем её как результат, чтобы не ретраить
    if (error.message.includes("LIMIT_EXCEEDED")) {
        return error; 
    }
    throw error;
  } finally {
    // 5. ГАРАНТИРОВАННАЯ ОЧИСТКА ФАЙЛОВ
    try {
        if (rawAudioFile && fs.existsSync(rawAudioFile)) {
            fs.unlinkSync(rawAudioFile);
            console.log(`[Cleanup] Deleted raw: ${rawAudioFile}`);
        }
        if (cleanAudioFile && fs.existsSync(cleanAudioFile)) {
            fs.unlinkSync(cleanAudioFile);
            console.log(`[Cleanup] Deleted clean: ${cleanAudioFile}`);
        }
    } catch(e) { 
        console.error('[Cleanup Error]:', e.message); 
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
    concurrency: 2, // Ограничиваем параллельность для экономии CPU на VAD
  });
  worker.on('failed', (job, err) => console.error(`[Worker] 💀 Job ${job.id} failed: ${err.message}`));
  return worker;
};

module.exports = { initWorker };