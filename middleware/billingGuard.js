const Redis = require('ioredis');
const { redisOptions } = require('../config/redis');

// Отдельное подключение для кэша и счетчиков
const redis = new Redis(redisOptions);

const LIMITS = {
  FREE: { daily_requests: 100, max_file_size_mb: 10 },
  PREMIUM: { daily_requests: 100, max_file_size_mb: 500 }
};

async function billingGuard(req, res, next) {
  try {
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

    // 2. Проверка размера контента (если это текст или ссылка - пропускаем, если файл - проверяем)
    // В данном примере упрощенно проверяем body.content.length для текста
    if (req.body.content && req.body.content.length > 50000 && userTier === 'FREE') {
       return res.status(400).json({ error: 'Text too long for Free tier' });
    }

    // Инкремент счетчика (увеличиваем на 1)
    await redis.incr(key);
    // Ставим время жизни ключа 24 часа + запас, чтобы не засорять память
    await redis.expire(key, 86400); 

    next();
  } catch (error) {
    console.error('Billing Guard Error:', error);
    // Если Redis упал, лучше заблокировать доступ или пропустить (зависит от политики)
    res.status(500).json({ error: 'Service temporarily unavailable' });
  }
}

module.exports = billingGuard;