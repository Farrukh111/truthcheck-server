// server/worker_entry.js
require('dotenv').config();
const { Worker } = require('bullmq');
const fs = require('fs');
const path = require('path');
const { connection } = require('./config/redis'); // Наш конфиг
const verificationWorker = require('./workers/verificationWorker'); // Ваша логика проверки

console.log('🚀 Verification Worker Starting...');

// ==========================================
// 1. ЗАПУСК ВОРКЕРА (ПОВАР)
// ==========================================
const worker = new Worker('verificationQueue', verificationWorker, {
  connection,
  concurrency: 2, // Обрабатываем по 2 задачи параллельно
  lockDuration: 60000,
});

worker.on('ready', () => {
  console.log('✅ [Worker] Ready to process jobs!');
});

worker.on('failed', (job, err) => {
  console.error(`❌ [Worker] Job ${job.id} failed: ${err.message}`);
});

worker.on('completed', (job) => {
  console.log(`✅ [Worker] Job ${job.id} completed!`);
});

// ==========================================
// 2. ДВОРНИК (CLEANUP SERVICE)
// ==========================================
const TEMP_DIR = path.join(__dirname, 'temp');

// Создаем папку temp, если её нет
if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
}

setInterval(() => {
  console.log('[Cleanup] 🧹 Checking for old files...');
  
  fs.readdir(TEMP_DIR, (err, files) => {
    if (err) return console.error('[Cleanup] Error reading dir:', err);

    const now = Date.now();
    files.forEach(file => {
      const filePath = path.join(TEMP_DIR, file);
      fs.stat(filePath, (err, stats) => {
        if (err) return;
        
        // Если файл старше 60 минут (3600000 мс)
        if (now - stats.mtimeMs > 3600000) {
           fs.unlink(filePath, (unlinkErr) => {
               if (!unlinkErr) console.log(`[Cleanup] 🗑️ Deleted old file: ${file}`);
           });
        }
      });
    });
  });
}, 1800000); // Запуск каждые 30 минут

// Graceful Shutdown (Аккуратное выключение)
process.on('SIGTERM', async () => {
  console.log('🛑 Worker shutting down...');
  await worker.close();
  process.exit(0);
});