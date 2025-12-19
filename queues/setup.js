const { Queue } = require('bullmq');
const { redisOptions, connection } = require('../config/redis');

let verificationQueue = null;

// 🔥 ГЛАВНАЯ ЗАЩИТА: Создаем очередь ТОЛЬКО если есть подключение
if (connection) {
  try {
    verificationQueue = new Queue('verification-queue', {
      connection: redisOptions,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: 100,
        removeOnFail: 500,
      },
    });
    console.log('✅ Queue system initialized');
  } catch (err) {
    console.error('❌ Failed to initialize queue:', err.message);
  }
} else {
  console.log('⚠️ Queues skipped: No Redis connection available.');
}

module.exports = { verificationQueue };