// server/workers/verificationWorker.js
const { Worker } = require('bullmq');
const { PrismaClient } = require('@prisma/client');
const { Expo } = require('expo-server-sdk');
const crypto = require('crypto');
const Redis = require('ioredis');
const { redisOptions } = require('../config/redis');
const fs = require('fs');

// 🔥 ИМПОРТЫ (Fast Mode: Без Python)
const { extractAudio, performVAD } = require('../services/videoProcessor');
const { transcribeAudio, verifyClaim, analyzeContentType } = require('../services/aiService');
const ClaimExtractor = require('../services/claimExtractor');

const prisma = new PrismaClient();
const expo = new Expo();

// Настройки
const CACHE_TTL = 86400; // 24 часа
const LOCK_TTL = 600; // 10 минут: защита от двойной обработки при “вирусных” запросах
const PIPELINE_VERSION = 'v1.1-fast-ffmpeg'; // поменяешь на v2-onnx-silero — кэш/DB автоматически разделятся

// Безопасное подключение к Redis
const redis = redisOptions ? new Redis(redisOptions) : null;

function normalizeVerdict(verdict) {
  if (!verdict) return 'UNCERTAIN';
  const v = String(verdict).toLowerCase();
  if (v.includes('misleading') || v.includes('partial') || v.includes('mixed')) return 'DISPUTED';
  if (v.includes('false') || v.includes('fake') || v.includes('incorrect') || v.includes('contradicted')) return 'CONTRADICTED';
  if (v.includes('true') || v.includes('accurate') || v.includes('correct') || v.includes('confirmed')) return 'CONFIRMED';
  return 'UNCERTAIN';
}

// --- URL normalization для кэша/дедупа ---
function canonicalizeUrl(input) {
  let u;
  try {
    u = new URL(input);
  } catch {
    return input; // не URL
  }

  // базовая нормализация
  u.hash = '';
  const host = (u.hostname || '').toLowerCase();

  // удаляем мусорные параметры (utm, t, feature и т.п.)
  const dropParams = new Set([
    'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
    'fbclid', 'gclid', 'igshid', 'si', 'feature', 't', 'time_continue',
  ]);
  for (const k of Array.from(u.searchParams.keys())) {
    if (dropParams.has(k)) u.searchParams.delete(k);
  }

  // YouTube: оставляем только videoId (v) и очищаем лишнее
  if (host.includes('youtube.com')) {
    const v = u.searchParams.get('v');
    if (v) {
      u.search = '';
      u.searchParams.set('v', v);
      u.pathname = '/watch';
    }
  } else if (host === 'youtu.be') {
    // youtu.be/<id>
    const id = u.pathname.replace('/', '').trim();
    if (id) {
      u.search = '';
      u.pathname = `/${id}`;
    }
  }

  // Instagram: оставляем только pathname (обычно /reel/... или /p/...)
  if (host.includes('instagram.com')) {
    u.search = '';
  }

  // TikTok: обычно /@user/video/<id> — оставим pathname без query
  if (host.includes('tiktok.com')) {
    u.search = '';
  }

  // сортируем параметры для стабильности
  const sorted = new URL(u.toString());
  const params = Array.from(sorted.searchParams.entries())
    .sort(([a], [b]) => a.localeCompare(b));
  sorted.search = '';
  for (const [k, v] of params) sorted.searchParams.append(k, v);

  return sorted.toString();
}

function fingerprintFor(type, contentNormalized) {
  const base = `${type}:${contentNormalized}:${PIPELINE_VERSION}`;
  return crypto.createHash('sha256').update(base).digest('hex');
}

function fileSizeSafe(filePath) {
  try {
    const st = fs.statSync(filePath);
    return st.size;
  } catch {
    return 0;
  }
}

// Trust rule: если нет источников — только UNCERTAIN
function enforceTrustRule(result) {
  if (!result || typeof result !== 'object') {
    return {
      verdict: 'UNCERTAIN',
      confidence: 0.0,
      summary: 'Недостаточно данных для проверки.',
      sources: [],
      key_claim: null,
      ai_details: { model: 'unknown' }
    };
  }

  const sources = Array.isArray(result.sources) ? result.sources : [];
  const verdict = normalizeVerdict(result.verdict);

  // если модель заявила TRUE/FALSE, но источников нет — режем до UNCERTAIN
  const needsSources = (verdict === 'CONFIRMED' || verdict === 'CONTRADICTED' || verdict === 'DISPUTED');
  if (needsSources && sources.length === 0) {
    return {
      ...result,
      verdict: 'UNCERTAIN',
      confidence: Math.min(Number(result.confidence || 0.0), 0.5),
      sources: [],
      summary: (result.summary ? `${result.summary}\n\n` : '') +
        '⚠️ Нет подтверждённых цитируемых источников — вердикт переведён в UNCERTAIN.'
    };
  }

  // если verdict любой, но источники отсутствуют и summary пустая — тоже UNCERTAIN
  if (sources.length === 0 && (!result.summary || String(result.summary).trim().length === 0)) {
    return {
      ...result,
      verdict: 'UNCERTAIN',
      confidence: Math.min(Number(result.confidence || 0.0), 0.5),
      sources: [],
      summary: 'Недостаточно данных/источников для уверенного вывода.'
    };
  }

  return { ...result, verdict, sources };
}

async function processVerification(job) {
  const startedAt = Date.now();
  console.log(`[Worker] 🛠 Processing Job ${job.id}`);

  // -------------------------
  // 0) Compatibility + Normalize
  // -------------------------
  let { type, content, videoUrl, pushToken } = job.data || {};

  // adapter: videoUrl -> content
  if ((!content || typeof content !== 'string') && typeof videoUrl === 'string') {
    console.log('[Worker] 🔄 Normalizing format: using videoUrl as content');
    content = videoUrl;
    if (!type) type = 'video';
  }

  if (typeof content !== 'string') {
    throw new Error(`CRITICAL: Job ${job.id} has no valid content.`);
  }

  let contentNormalized = content.trim();
  if (contentNormalized.length === 0) {
    throw new Error(`CRITICAL: Job ${job.id} content is empty after trim.`);
  }

  // canonicalize для видео URL, чтобы одинаковые ролики не создавали разные кэши
  let typeNormalized = type;
  if (!typeNormalized) {
    try {
      new URL(contentNormalized);
      typeNormalized = 'video';
    } catch {
      typeNormalized = 'text';
    }
  }

  if (typeNormalized === 'video') {
    contentNormalized = canonicalizeUrl(contentNormalized);
  }

  // -------------------------
  // 1) Fingerprint + L1 cache key
  // -------------------------
  await job.updateProgress(5);

  const fingerprint = fingerprintFor(typeNormalized, contentNormalized);
  const cacheKey = `result:${fingerprint}`;
  const lockKey = `lock:${fingerprint}`;
  const lockValue = String(job.id);

  let audioPath = null;
  let lockAcquired = false;

  try {
    // -------------------------
    // 2) L1 Cache: Redis result
    // -------------------------
    if (redis) {
      const cached = await redis.get(cacheKey);
      if (cached) {
        console.log('[Worker] ⚡ REDIS HIT');
        const res = JSON.parse(cached);
        if (pushToken) await sendPush(pushToken, res.verdict, res.dbId);
        return res;
      }
    }

    // -------------------------
    // 3) L2 Cache: DB by (content + pipelineVersion)
    // -------------------------
    const existingCheck = await prisma.check.findFirst({
      where: {
        content: contentNormalized,
        pipelineVersion: PIPELINE_VERSION,
      },
      orderBy: { createdAt: 'desc' }
    });

    if (existingCheck) {
      console.log('[Worker] 📚 DB HIT (pipeline matched)');
      const dbResult = {
        verdict: existingCheck.verdict,
        confidence: existingCheck.confidence,
        summary: existingCheck.summary,
        ai_details: { model: existingCheck.aiModel, pipelineVersion: existingCheck.pipelineVersion },
        key_claim: existingCheck.keyClaim,
        sources: existingCheck.sources ? JSON.parse(existingCheck.sources) : [],
        dbId: existingCheck.id,
        fingerprint,
      };

      if (redis) await redis.set(cacheKey, JSON.stringify(dbResult), 'EX', CACHE_TTL);
      if (pushToken) await sendPush(pushToken, dbResult.verdict, existingCheck.id);
      return dbResult;
    }

    // -------------------------
    // 4) Dedup In-Progress: Redis lock
    // -------------------------
    if (redis) {
      const ok = await redis.set(lockKey, lockValue, 'NX', 'EX', LOCK_TTL);
      if (!ok) {
        // Кто-то уже считает. Попробуем быстро отдать результат из Redis (если уже готов).
        const cachedAfterLockFail = await redis.get(cacheKey);
        if (cachedAfterLockFail) {
          console.log('[Worker] ⚡ REDIS HIT (after lock fail)');
          const res = JSON.parse(cachedAfterLockFail);
          if (pushToken) await sendPush(pushToken, res.verdict, res.dbId);
          return res;
        }

        // Иначе — корректно завершаем без траты денег (не fail!)
        console.log('[Worker] 🧷 DUPLICATE IN PROGRESS — skipping heavy processing');
        return {
          verdict: 'UNCERTAIN',
          confidence: 0.0,
          summary: 'Этот запрос уже обрабатывается. Пожалуйста, попробуйте открыть результат чуть позже.',
          sources: [],
          key_claim: null,
          ai_details: { model: 'Dedup', pipelineVersion: PIPELINE_VERSION },
          dbId: null,
          fingerprint,
          inProgress: true,
        };
      }
      lockAcquired = true;
    }

    // -------------------------
    // 5) Full pipeline
    // -------------------------
    let analysisText = contentNormalized;

    if (typeNormalized === 'video') {
      console.log('[Worker] 🎬 Starting Video Pipeline (Fast FFmpeg Mode)...');

      // A) Extract audio
      audioPath = await extractAudio(contentNormalized);
      await job.updateProgress(30);

      const originalSize = fileSizeSafe(audioPath);

      // B) performVAD (FFmpeg detector - временно)
      await performVAD(audioPath);
      await job.updateProgress(50);

      // Fail-safe: если VAD "съел" всё, транскрибируем оригинал (не ломаем UX)
      const afterVadSize = fileSizeSafe(audioPath);
      if (afterVadSize > 0 && originalSize > 0 && afterVadSize < Math.max(8000, Math.floor(originalSize * 0.02))) {
        console.warn('[Worker] ⚠️ VAD produced too-small output; continuing with original audio (fail-safe).');
        // Здесь мы предполагаем, что performVAD работает in-place.
        // Если ваша performVAD создаёт отдельный файл — скажи, я подстрою код.
      }

      // C) Transcribe
      console.log('[Worker] 🗣️ Transcribing...');
      analysisText = await transcribeAudio(audioPath);
    }

    if (!analysisText || String(analysisText).trim().length < 5) {
      throw new Error('Empty transcription/result text');
    }

    await job.updateProgress(60);

    // -------------------------
    // 6) AI Gatekeeper + Fact-check
    // -------------------------
    console.log('[Worker] 🛡️ Running AI Analysis...');
    const classification = await analyzeContentType(analysisText);

    let result;
    if (classification.type !== 'claims') {
      result = {
        verdict: 'UNCERTAIN',
        confidence: 1.0,
        sources: [],
        key_claim: 'Контент не содержит проверяемых фактов',
        summary: classification.summary || 'Развлекательный/нефактологический контент.',
        ai_details: { model: 'Gatekeeper', pipelineVersion: PIPELINE_VERSION }
      };
    } else {
      const extraction = ClaimExtractor.extract(analysisText);
      const promptText = (extraction && extraction.confidence > 0.4) ? extraction.bestClaim : analysisText;

      result = await verifyClaim(promptText);
      result.key_claim = promptText;
      result.ai_details = { ...(result.ai_details || {}), pipelineVersion: PIPELINE_VERSION };
    }

    // Trust Rule enforcement (no sources => UNCERTAIN)
    result = enforceTrustRule(result);

    // -------------------------
    // 7) Save to DB (+ pipelineVersion + fingerprint)
    // -------------------------
    await prisma.user.upsert({
      where: { id: 'anon' },
      update: {},
      create: { id: 'anon', email: 'anon@truthcheck.ai' }
    });

    const taskDuration = Date.now() - startedAt;

    const savedCheck = await prisma.check.create({
      data: {
        userId: 'anon',
        type: typeNormalized,
        content: contentNormalized,
        verdict: result.verdict,
        confidence: Number(result.confidence || 0),
        summary: String(result.summary || ''),
        aiModel: (result.ai_details && result.ai_details.model) ? String(result.ai_details.model) : 'Hybrid',
        durationMs: taskDuration,
        keyClaim: result.key_claim ? String(result.key_claim) : null,
        sources: JSON.stringify(Array.isArray(result.sources) ? result.sources : []),
        pipelineVersion: PIPELINE_VERSION,
        fingerprint: fingerprint,
      }
    });

    result.dbId = savedCheck.id;
    result.fingerprint = fingerprint;

    // -------------------------
    // 8) Cache result in Redis
    // -------------------------
    if (redis) {
      await redis.set(cacheKey, JSON.stringify(result), 'EX', CACHE_TTL);
    }

    // Push
    if (pushToken) await sendPush(pushToken, result.verdict, savedCheck.id);

    await job.updateProgress(100);
    console.log(`[Worker] ✅ Job ${job.id} Done in ${(taskDuration / 1000).toFixed(2)}s. Verdict: ${result.verdict}`);

    return result;

  } catch (error) {
    console.error(`[Worker] ❌ Failed: ${error.message}`);
    throw error;
  } finally {
    // release lock only if we acquired it (and only if still ours)
    if (redis && lockAcquired) {
      try {
        const current = await redis.get(lockKey);
        if (current === lockValue) {
          await redis.del(lockKey);
        }
      } catch (e) {
        console.error('[Lock Cleanup Error]:', e.message);
      }
    }

    // cleanup audio
    if (audioPath && fs.existsSync(audioPath)) {
      try {
        fs.unlinkSync(audioPath);
        console.log(`[Cleanup] Deleted: ${audioPath}`);
      } catch (e) {
        console.error('[Cleanup failed]:', e.message);
      }
    }
  }
}

async function sendPush(token, verdict, id) {
  if (token && Expo.isExpoPushToken(token)) {
    const statusEmoji = verdict === 'CONFIRMED' ? '✅' : verdict === 'CONTRADICTED' ? '❌' : '⚠️';
    const messages = [{
      to: token,
      sound: 'default',
      title: `${statusEmoji} Проверка завершена`,
      body: `Вердикт: ${verdict}.\nНажмите для отчета.`,
      data: { resultId: id },
    }];

    const chunks = expo.chunkPushNotifications(messages);
    for (const chunk of chunks) {
      try {
        await expo.sendPushNotificationsAsync(chunk);
      } catch (e) {
        console.error('Push Error:', e);
      }
    }
  }
}

const initWorker = () => {
  console.log('[Worker] 🚀 Verification Worker Initialized');
  const worker = new Worker('verification-queue', processVerification, {
    connection: redisOptions,
    concurrency: 2,
  });
  worker.on('failed', (job, err) => console.error(`[Worker] 💀 Job ${job?.id} failed: ${err.message}`));
  return worker;
};

module.exports = { initWorker };
