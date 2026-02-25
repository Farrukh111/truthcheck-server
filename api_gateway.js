// server/api_gateway.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { QueueEvents } = require('bullmq');
const { verificationQueue } = require('./queues/setup');
const { PrismaClient } = require('@prisma/client');
const { redisOptions } = require('./config/redis');

// 🔥 FIX: Импорт DNS для защиты SSRF
const dns = require('dns').promises;
const { URL } = require('url');

const prisma = new PrismaClient();
const app = express();

app.set('trust proxy', 1);
app.use(express.json());
app.use(cors());

// 🔥 FIX: Создаем слушатель событий ТОЛЬКО если есть настройки Redis
const queueEvents = redisOptions
  ? new QueueEvents('verification-queue', { connection: redisOptions })
  : null;

// Лимитер (оставляем, но он пока не будет мешать)
const statusLimiter = rateLimit({
  windowMs: 3000,
  max: 20, // Увеличил лимит для тестов
  message: { error: 'Too many requests' },
  standardHeaders: true,
  legacyHeaders: false,
});
async function ensureQueueReady(timeoutMs = 1500) {
  if (!verificationQueue) return false;

  try {
    await Promise.race([
      verificationQueue.waitUntilReady(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Queue readiness timeout')), timeoutMs)
      )
    ]);
    return true;
  } catch (error) {
    console.error('[API] Queue is not ready:', error.message);
    return false;
  }
}
// 🔥🔥🔥 DEV MODE: ОТКЛЮЧЕНИЕ АУТЕНТИФИКАЦИИ 🔥🔥🔥
// Этот блок позволяет тестировать API без токенов.
// ПЕРЕД ПРОДАКШЕНОМ ЭТОТ БЛОК НУЖНО УДАЛИТЬ!
app.use((req, res, next) => {
  console.log(`[DEV-MODE] 🔓 Auth Bypass: Request to ${req.path}`);
  req.user = {
    id: 'benchmark-admin-id',
    userId: 'benchmark-admin-id',
    email: 'dev@local.host'
  };
  next();
});
// 🔥🔥🔥 КОНЕЦ БЛОКА DEV MODE 🔥🔥🔥


// 🔥 FIX: Бронебойная защита от SSRF (DNS Resolution)
async function isDangerousUrl(inputUrl) {
  if (!inputUrl || typeof inputUrl !== 'string') return true;
  try {
    const parsed = new URL(inputUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) return true;

    const hostname = parsed.hostname;
    if (['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(hostname)) return true;

    try {
      const addresses = await dns.resolve(hostname);
      if (!addresses || addresses.length === 0) return true;

      for (const ip of addresses) {
        if (
          ip.startsWith('10.') ||
          ip.startsWith('192.168.') ||
          ip.startsWith('127.') ||
          ip.startsWith('169.254.') ||
          /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(ip)
        ) {
          console.warn(`[Security] Blocked local IP access: ${hostname} -> ${ip}`);
          return true;
        }
      }
    } catch (e) {
      // если DNS не резолвится — пропускаем только YouTube домены (как раньше)
      if (!hostname.includes('youtube.com') && !hostname.includes('youtu.be')) {
        return true;
      }
    }
    return false;
  } catch (e) {
    return true;
  }
}

// === ЭНДПОИНТЫ ===

// 0. Корневой маршрут
app.get('/', (req, res) => {
  res.status(200).json({
    service: "TruthCheck AI API",
    status: "🟢 Online (Dev Mode)",
    version: "1.0.0-benchmark"
  });
});

// 1. Отправка задачи (БЕЗ Auth и Billing middleware для скорости)
app.post('/api/v1/verify', async (req, res) => {
  const { type, content, claimId, pushToken, videoUrl } = req.body;

  // Поддержка и videoUrl и content (для совместимости)
  const finalContent = videoUrl || content;

  if (!finalContent) return res.status(400).json({ error: 'Content/videoUrl is required' });

    const isUrlPayload = (() => {
    if (type === 'video') return true;
    try { new URL(finalContent); return true; } catch { return false; }
  })();

  // Проверка безопасности только для URL-контента
  if (isUrlPayload && await isDangerousUrl(finalContent)) {
    console.warn(`[Security] Blocked SSRF: ${finalContent}`);
    return res.status(403).json({ error: 'Invalid or restricted URL' });
  }

  try {
    if (!(await ensureQueueReady())) {
      console.error("[API] Queue not initialized (Redis missing?)");
      return res.status(503).json({ error: 'Service unavailable (Queue offline)' });
    }

    // Определение типа, если не задан
    const inferredType = type || (await (async () => {
      try { new URL(finalContent); return 'video'; } catch { return 'text'; }
    })());

    // ⛔️ ВАЖНО: останавливаем бесконечные ретраи
    const job = await verificationQueue.add('verify-claim', {
      userId: req.user.id,
      videoUrl: finalContent,
      type: inferredType,
      claimId,
      pushToken
    }, {
      attempts: 1,
      removeOnComplete: true,
      removeOnFail: { age: 3600 }
    });

    console.log(`[API] Job ${job.id} queued for ${finalContent}`);
    res.status(202).json({ status: 'queued', jobId: job.id });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Queue failed' });
  }
});

// 2. Статус (БЕЗ Auth)
app.get('/api/v1/status/:jobId', statusLimiter, async (req, res) => {
  try {
    if (!(await ensureQueueReady())) return res.status(503).json({ error: 'Queue offline' });

    const job = await verificationQueue.getJob(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    const state = await job.getState();
    res.json({
      id: job.id,
      state,
      progress: job.progress,
      result: job.returnvalue,
      error: job.failedReason
    });
  } catch (error) {
    res.status(500).json({ error: 'Status check failed' });
  }
});

// 3. SSE Стрим
app.get('/api/v1/events/:jobId', async (req, res) => {
  const { jobId } = req.params;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const sendData = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };
  if (!(await ensureQueueReady())) {
    sendData({ status: 'failed', error: 'Queue offline' });
    return res.end();
  }


  // Проверка статуса (если уже готово — сразу отдать)
  const checkImmediate = async () => {
    try {
      const job = await verificationQueue.getJob(jobId);
      if (!job) return;
      const state = await job.getState();
      if (state === 'completed') {
        sendData({ status: 'completed', result: job.returnvalue, progress: 100 });
      } else if (state === 'failed') {
        sendData({ status: 'failed', error: job.failedReason });
      }
    } catch (e) {}
  };
  await checkImmediate();

  const heartbeat = setInterval(() => res.write(`: ping\n\n`), 15000);

  const onProgress = ({ jobId: id, data }) => {
    if (id === jobId) sendData({ status: 'processing', progress: data });
  };

  const onCompleted = ({ jobId: id, returnvalue }) => {
    if (id === jobId) {
      sendData({ status: 'completed', result: returnvalue, progress: 100 });
      res.end();
    }
  };

  const onFailed = ({ jobId: id, failedReason }) => {
    if (id === jobId) {
      sendData({ status: 'failed', error: failedReason });
      res.end();
    }
  };

  if (queueEvents) {
    queueEvents.on('progress', onProgress);
    queueEvents.on('completed', onCompleted);
    queueEvents.on('failed', onFailed);
  }

  req.on('close', () => {
    clearInterval(heartbeat);
    if (queueEvents) {
      queueEvents.off('progress', onProgress);
      queueEvents.off('completed', onCompleted);
      queueEvents.off('failed', onFailed);
    }
  });
});

// ✅ 4. Health Checks
// Render пингует этот путь
app.get('/healthz', (req, res) => {
  res.status(200).send('OK');
});

// Глубокая проверка для ручного мониторинга
app.get('/health', async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    const redisClient = await verificationQueue.client;
    const redisStatus = await redisClient.ping();

    res.json({
      status: 'healthy',
      database: 'connected',
      redis: redisStatus === 'PONG' ? 'connected' : 'error'
    });
  } catch (error) {
    console.error('[Health] Check failed:', error);
    res.status(500).json({
      status: 'unhealthy',
      error: error.message
    });
  } // <-- ДОБАВЛЕНО
});
// 5. Тестовый вход (Mock Login для совместимости)
app.post('/api/v1/auth/login', (req, res) => {
  res.json({ token: 'mock-token-for-benchmark', user: { id: 1, email: 'dev@test' } });
});

const PORT = process.env.PORT || 10000;

// Оставляем только один вызов и обязательно указываем '0.0.0.0'
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 API Gateway running on port ${PORT}`);
  
});