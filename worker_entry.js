require('dotenv').config();
const { initWorker } = require('./workers/verificationWorker');
const fs = require('fs');
const path = require('path');

// Запуск основного воркера
initWorker();

// 🔥 ДВОРНИК (CLEANUP SERVICE)
// Удаляет временные файлы старше 1 часа каждые 30 минут
const TEMP_DIR = path.join(__dirname, 'temp');

setInterval(() => {
  console.log('[Cleanup] 🧹 Checking for old files...');
  if (!fs.existsSync(TEMP_DIR)) return;

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
}, 1800000); // 30 минут

// Graceful Shutdown
process.on('SIGTERM', async () => {
  console.log('Worker is shutting down...');
  process.exit(0);
});