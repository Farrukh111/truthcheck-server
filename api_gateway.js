// server/api_gateway.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { QueueEvents } = require('bullmq');
const { verificationQueue } = require('./queues/setup');
const { PrismaClient } = require('@prisma/client');
const { redisOptions } = require('./config/redis');

// 🔥 SSRF / DNS
const dns = require('dns').promises;
const { URL } = require('url');

// ✅ Health Redis ping — нужен реальный Redis client
const Redis = require('ioredis');

const prisma = new PrismaClient();
const app = express();

app.set('trust proxy', 1);
app.use(express.json());
app.use(cors());

// ✅ Redis client только для health-check (и можно использовать в будущем)
const healthRedis = redisOptions ? new Redis(redisOptions) : null;
if (healthRedis) {
  healthRedis.on('error', (e) => console.warn('[HealthRedis] Redis error:', e.message));
}

// ✅ QueueEvents — только если есть Redis
const queueEvents = redisOptions
  ? new QueueEvents('verification-queue', { connection: redisOptions })
  : null;

// Лимитер статуса (для тестов оставим мягким)
const statusLimiter = rateLimit({
  windowMs: 3000,
  max: 20,
  message: { error: 'Too many requests' },
  standardHeaders: true,
  legacyHeaders: false,
});

// 🔥🔥🔥 DEV MODE: Auth Bypass (оставляем как ты просил — пока тесты не пройдены)
app.use((req, res, next) => {
  console.log(`[DEV-MODE] 🔓 Auth Bypass: Request to ${req.path}`);
  req.user = {
    id: 'benchmark-admin-id',
    userId: 'benchmark-admin-id',
    email: 'dev@local.host',
  };
  next();
});
// 🔥🔥🔥 END DEV MODE

// ✅ SSRF защита через DNS resolution + базовые запреты
async function isDangerousUrl(inputUrl) {
  if (!inputUrl || typeof inputUrl !== 'string') return true;

  try {
    const parsed = new URL(inputUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) return true;

    const hostname = parsed.hostname?.toLowerCase();
    if (!hostname) return true;

    // Явные локальные
    if (['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(hostname)) return true;

    // DNS resolve
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
      // Если DNS не резолвится — разрешаем только YouTube (как у тебя было)
      if (!hostname.includes('youtube.com') && !hostname.includes('youtu.be')) return true;
    }

    return false;
  } catch (e) {
    return true;
  }
}

// === ROUTES ===

// Root
app.get('/', (req, res) => {
  res.status(200).json({
    service: 'TruthCheck AI API',
    status: '🟢 Online (Dev Mode)',
    version: '1.0.0-benchmark',
  });
});

// ✅ Healthz — простой, чтобы Render не убивал сервис
app.get('/healthz', (req, res) => {
  res.status(200).send('OK');
});

// ✅ Health — проверка зависимостей (Redis + DB)
app.get('/health', async (req, res) => {
  const details = {};
  let ok = true;

  // Redis
  try {
    if (!healthRedis) throw new Error('Redis not configured');
    const pong = await healthRedis.ping();
    details.redis = pong === 'PONG' ? 'ok' : `unexpected:${pong}`;
  } catch (e) {
    ok = false;
    details.redis = `error:${e.message}`;
  }

  // DB
  try {
    await prisma.$queryRaw`SELECT 1`;
    details.db = 'ok';
  } catch (e) {
    ok = false;
    details.db = `error:${e.message}`;
  }

  if (ok) {
    return res.status(200).json({ status: 'ok', uptime: process.uptime(), details });
  }
  return res.status(503).json({ status: 'error', uptime: process.uptime(), details });
});

// Verify
app.post('/api/v1/verify', async (req, res) => {
  const { type, content, claimId, pushToken, videoUrl } = req.body;

  const finalContent = videoUrl || content;
  if (!finalContent) return res.status(400).json({ error: 'Content/videoUrl is required' });

  if (await isDangerousUrl(finalContent)) {
    console.warn(`[Security] Blocked SSRF: ${finalContent}`);
    return res.status(403).json({ error: 'Invalid or restricted URL' });
  }

  try {
    if (!verificationQueue) {
      console.error('[API] Queue not initialized (Redis missing?)');
      return res.status(503).json({ error: 'Service unavailable (Queue offline)' });
    }

    const inferredType = type || (() => {
      try { new URL(finalContent); return 'video'; } catch { return 'text'; }
    })();

    const job = await verificationQueue.add('verify-claim', {
      userId: req.user.id,
      videoUrl: finalContent,
      type: inferredType,
      claimId,
      pushToken,
    });

    console.log(`[API] Job ${job.id} queued for ${finalContent}`);
    return res.status(202).json({ status: 'queued', jobId: job.id });
  } catch (error) {
    console.error('[API] Queue add failed:', error);
    return res.status(500).json({ error: 'Queue failed' });
  }
});

// Status
app.get('/api/v1/status/:jobId', statusLimiter, async (req, res) => {
  try {
    if (!verificationQueue) return res.status(503).json({ error: 'Queue offline' });

    const job = await verificationQueue.getJob(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    const state = await job.getState();
    return res.json({
      id: job.id,
      state,
      progress: job.progress,
      result: job.returnvalue,
      error: job.failedReason,
    });
  } catch (error) {
    return res.status(500).json({ error: 'Status check failed' });
  }
});

// SSE
app.get('/api/v1/events/:jobId', async (req, res) => {
  const { jobId } = req.params;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const sendData = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  const checkImmediate = async () => {
    try {
      if (!verificationQueue) return;
      const job = await verificationQueue.getJob(jobId);
      if (!job) return;
      const state = await job.getState();
      if (state === 'completed') sendData({ status: 'completed', result: job.returnvalue, progress: 100 });
      if (state === 'failed') sendData({ status: 'failed', error: job.failedReason });
    } catch {}
  };

  await checkImmediate();
  const heartbeat = setInterval(() => res.write(`: ping\n\n`), 15000);

  const onProgress = ({ jobId: id, data }) => { if (id === jobId) sendData({ status: 'processing', progress: data }); };
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

// Mock login (dev)
app.post('/api/v1/auth/login', (req, res) => {
  res.json({ token: 'mock-token-for-benchmark', user: { id: 1, email: 'dev@test' } });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 API Gateway running on ${PORT}`));
