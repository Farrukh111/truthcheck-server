require('dotenv').config();

const isProduction = process.env.NODE_ENV === 'production' || process.env.RENDER;
let connection = null;

if (process.env.REDIS_URL) {
  connection = process.env.REDIS_URL;
  console.log("✅ Redis URL found. Connecting...");
} else if (!isProduction) {
  connection = {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: process.env.REDIS_PORT || 6379,
  };
  console.log("🏠 Local development detected. Using localhost Redis.");
} else {
  console.warn("⚠️ WARNING: No REDIS_URL found in production. Redis features disabled.");
  connection = null;
}

const redisOptions = connection 
    ? (typeof connection === 'string' ? connection : { ...connection, maxRetriesPerRequest: null })
    : null;

module.exports = { redisOptions, connection };