const { Queue } = require('bullmq');
const { redisOptions } = require('../config/redis');

// Создаем очередь с именем 'verification-queue'
const verificationQueue = new Queue('verification-queue', {
  connection: redisOptions
});

module.exports = { verificationQueue };