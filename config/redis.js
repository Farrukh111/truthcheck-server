require('dotenv').config();
const { URL } = require('url');

const isProduction = process.env.NODE_ENV === 'production' || process.env.RENDER;
let redisOptions = null;

if (process.env.REDIS_URL) {
  try {
    // 🛠️ ПАРСИНГ: Превращаем строку-ссылку в объект настроек
    // Это критически важно для BullMQ, чтобы он не лез на localhost
    const parsed = new URL(process.env.REDIS_URL);
    
    redisOptions = {
      host: parsed.hostname,
      port: Number(parsed.port),
      username: parsed.username || undefined,
      password: parsed.password || undefined,
      // Для Upstash и Render обязательно включаем TLS
      tls: parsed.protocol === 'rediss:' ? { rejectUnauthorized: false } : undefined,
      maxRetriesPerRequest: null, // Обязательно для BullMQ
      enableOfflineQueue: false,
    };
    console.log("✅ Redis Configured from URL:", redisOptions.host);
  } catch (e) {
    console.error("❌ Failed to parse REDIS_URL:", e.message);
    redisOptions = null;
  }
} else if (!isProduction) {
  // Локальная разработка
  redisOptions = {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: process.env.REDIS_PORT || 6379,
    maxRetriesPerRequest: null,
  };
  console.log("🏠 Local Redis Configured");
} else {
  console.warn("⚠️ WARNING: No REDIS_URL found in production.");
  redisOptions = null;
}

// Экспортируем и как redisOptions, и как connection для совместимости
module.exports = { 
  redisOptions, 
  connection: redisOptions 
};