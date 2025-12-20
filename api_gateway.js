// server/api_gateway.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { QueueEvents } = require('bullmq');
const { verificationQueue } = require('./queues/setup');
const billingGuard = require('./middleware/billingGuard');
const authMiddleware = require('./middleware/auth');
const { PrismaClient } = require('@prisma/client');
const { redisOptions } = require('./config/redis'); // Используем наш безопасный конфиг

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

// Лимитер для статуса (хранит в памяти по умолчанию, так что Redis тут не нужен)
const statusLimiter = rateLimit({
  windowMs: 3000, 
  max: 5, 
  message: { error: 'Too many requests' },
  standardHeaders: true,
  legacyHeaders: false,
});

// 🔥 FIX: Бронебойная защита от SSRF (DNS Resolution)
async function isDangerousUrl(inputUrl) {
    if (!inputUrl || typeof inputUrl !== 'string') return true;
    try {
        const parsed = new URL(inputUrl);
        // Разрешаем только HTTP/HTTPS
        if (!['http:', 'https:'].includes(parsed.protocol)) return true;

        const hostname = parsed.hostname;
        // 1. Быстрая проверка на локалхост
        if (['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(hostname)) return true;

        // 2. DNS Резолвинг (Узнаем реальный IP за доменом)
        try {
            const addresses = await dns.resolve(hostname);
            if (!addresses || addresses.length === 0) return true; 

            for (const ip of addresses) {
                // Блокируем приватные диапазоны IP (RFC 1918)
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
            // Если домен не резолвится, но это YouTube - пропускаем (yt-dlp разберется)
            // Иначе блокируем для безопасности
            if (!hostname.includes('youtube.com') && !hostname.includes('youtu.be')) {
                return true;
            }
        }

        return false;
    } catch (e) {
        return true; // Если URL кривой - блокируем
    }
}

// === ЭНДПОИНТЫ ===
// 👇 ВСТАВИТЬ СЮДА (НАЧАЛО)
// Корневой маршрут - Визитка для инвесторов/Bytez
app.get('/', (req, res) => {
  res.status(200).json({
    service: "TruthCheck AI API",
    status: "🟢 Online",
    version: "1.0.0-beta",
    description: "Multi-modal forensic fact-checking engine for short-form video.",
    documentation: "Private (Available upon request)"
  });
});
// 👆 ВСТАВИТЬ СЮДА (КОНЕЦ)
// 1. Отправка задачи
app.post('/api/v1/verify', authMiddleware, billingGuard, async (req, res) => {
  const { type, content, claimId, pushToken } = req.body;

  if (!content) return res.status(400).json({ error: 'Content is required' });

  // 🔥 FIX: Асинхронная проверка безопасности
  if (await isDangerousUrl(content)) {
      console.warn(`[Security] Blocked SSRF: ${content}`);
      return res.status(403).json({ error: 'Invalid or restricted URL' });
  }

  try {
    // Проверка: запущена ли очередь?
    if (!verificationQueue) {
        console.error("[API] Queue not initialized (Redis missing?)");
        return res.status(503).json({ error: 'Service unavailable (Queue offline)' });
    }

    const job = await verificationQueue.add('verify-claim', {
      userId: req.user.id,
      type, content, claimId, pushToken
    });

    console.log(`[API] Job ${job.id} queued`);
    res.status(202).json({ status: 'queued', jobId: job.id });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Queue failed' });
  }
});

// 2. Статус
app.get('/api/v1/status/:jobId', authMiddleware, statusLimiter, async (req, res) => {
  try {
    if (!verificationQueue) return res.status(503).json({ error: 'Queue offline' });

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

    let sequenceId = 0;
    const sendData = (data) => {
        sequenceId++;
        res.write(`id: ${sequenceId}\n`);
        res.write(`data: ${JSON.stringify({ ...data, seq: sequenceId })}\n\n`);
    };

    const checkImmediateStatus = async () => {
        try {
            if (!verificationQueue) return false;
            const job = await verificationQueue.getJob(jobId);
            if (!job) return false;

            const state = await job.getState();
            if (state === 'completed' && job.returnvalue) {
                let result = job.returnvalue;
                if (typeof result === 'string') { try { result = JSON.parse(result); } catch(e){} }
                sendData({ status: 'completed', result, progress: 100 });
                res.end();
                return true;
            } 
            if (state === 'failed') {
                sendData({ status: 'failed', error: job.failedReason });
                res.end();
                return true;
            }
        } catch (e) {}
        return false;
    };

    if (await checkImmediateStatus()) return;

    const heartbeat = setInterval(() => res.write(`: ping\n\n`), 15000);
    const idleTimeout = setTimeout(() => { res.end(); }, 120000); // 2 минуты

    const onProgress = ({ jobId: id, data }) => {
        if (id === jobId) {
            idleTimeout.refresh();
            const payload = typeof data === 'number' ? { progress: data } : data;
            sendData({ status: 'processing', ...payload });
        }
    };
    
    const onCompleted = async ({ jobId: id, returnvalue }) => {
        if (id === jobId) {
            let result = returnvalue;
            try { if (typeof returnvalue === 'string') result = JSON.parse(returnvalue); } catch(e) {}
            sendData({ status: 'completed', result, progress: 100 });
            res.end(); 
        }
    };

    const onFailed = ({ jobId: id, failedReason }) => {
        if (id === jobId) {
            sendData({ status: 'failed', error: failedReason });
            res.end();
        }
    };

    // 🔥 FIX: Подписываемся только если Redis доступен
    if (queueEvents) {
        queueEvents.on('progress', onProgress);
        queueEvents.on('completed', onCompleted);
        queueEvents.on('failed', onFailed);
    } else {
        // Если Redis нет, SSE будет работать как "длинный опрос" только для завершенных задач
        console.warn("[SSE] QueueEvents disabled (No Redis). Real-time updates limited.");
    }

    req.on('close', () => {
        clearInterval(heartbeat);
        clearTimeout(idleTimeout);
        // 🔥 FIX: Отписываемся безопасно
        if (queueEvents) {
            queueEvents.off('progress', onProgress);
            queueEvents.off('completed', onCompleted);
            queueEvents.off('failed', onFailed);
        }
    });
});

// 4. Health
app.get('/health', async (req, res) => {
    try {
        if (verificationQueue) await verificationQueue.client.ping(); 
        await prisma.$queryRaw`SELECT 1`;      
        res.json({ status: 'ok', uptime: process.uptime() });
    } catch (e) {
        res.status(503).json({ status: 'error', reason: e.message });
    }
});

// 5. История и удаление
app.delete('/api/v1/history', authMiddleware, async (req, res) => {
    try {
        const { count } = await prisma.check.deleteMany({ where: { userId: req.user.id } });
        res.json({ success: true, deleted: count });
    } catch (e) {
        res.status(500).json({ error: 'Failed to delete data' });
    }
});

app.get('/api/v1/check/:id', authMiddleware, async (req, res) => {
    try {
        const check = await prisma.check.findUnique({ where: { id: req.params.id } });
        if (!check) return res.status(404).json({ error: 'Not found' });
        res.json({ success: true, data: { ...check, sources: check.sources ? JSON.parse(check.sources) : [] } });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 API Gateway running on ${PORT}`));