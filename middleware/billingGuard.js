const Redis = require('ioredis');
const { redisOptions } = require('../config/redis');

// 🔥 FIX: Безопасное создание. Если настроек нет — redis будет null.
const redis = redisOptions ? new Redis(redisOptions) : null;

const LIMITS = {
  FREE: { daily_requests: 100, max_file_size_mb: 10 },
  PREMIUM: { daily_requests: 100, max_file_size_mb: 500 }
};

async function billingGuard(req, res, next) {
  try {
    // 🔥 FIX: Если Redis отключен (бесплатный режим/ошибка), пропускаем проверку.
    // Сервер работает, просто без лимитов.
    if (!redis) return next();

    const userId = req.user.id;
    const userTier = req.user.tier || 'FREE';
    
    // Ключ для счетчика: usage:user_123:2023-10-27
    const today = new Date().toISOString().slice(0, 10);
    const key = `usage:${userId}:${today}`;

    // 1. Проверка количества запросов
    const currentUsage = await redis.get(key);
    if (currentUsage && parseInt(currentUsage) >= LIMITS[userTier].daily_requests) {
      return res.status(429).json({ 
        error: `Daily limit of ${LIMITS[userTier].daily_requests} requests exceeded.` 
      });
    }

    // 2. Проверка размера контента
    if (req.body.content && req.body.content.length > 50000 && userTier === 'FREE') {
       return res.status(400).json({ error: 'Text too long for Free tier' });
    }

    // Инкремент счетчика
    await redis.incr(key);
    await redis.expire(key, 86400); 

    next();
  } catch (error) {
    console.error('Billing Guard Error:', error);
    // Если Redis упал в процессе, пропускаем пользователя (Fail Open), чтобы не ломать сервис
    next();
  }
}

module.exports = billingGuard;