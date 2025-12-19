require('dotenv').config();

// Эта логика автоматически поймет: мы на Render (есть REDIS_URL) или дома (localhost)
const connection = process.env.REDIS_URL 
  ? process.env.REDIS_URL 
  : {
      host: process.env.REDIS_HOST || 'localhost',
      port: process.env.REDIS_PORT || 6379,
    };

const redisOptions = typeof connection === 'string' 
    ? connection 
    : { ...connection, maxRetriesPerRequest: null };

module.exports = { redisOptions, connection };