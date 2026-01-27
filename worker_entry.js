require('dotenv').config();
const { initWorker } = require('./workers/verificationWorker');
const fs = require('fs');
const path = require('path');
const http = require('http'); // 👈 Добавили модуль для сервера

console.log('🚀 Verification Worker Starting...');

// ==========================================
// 1. ЗАПУСК ВОРКЕРА (ПОВАР)
// ==========================================
const worker = initWorker(); 

// ==========================================
// 2. ОБМАН RENDER (HEALTH CHECK) 🔥 ВАЖНО
// ==========================================
// Render убьет сервис через 5 мин, если мы не откроем порт.
const PORT = process.env.PORT || 10000;

const server = http.createServer((req, res) => {
    // Отвечаем "Я жив" на любой запрос
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Worker is active. Cleanup service is running.');
});

server.listen(PORT, () => {
    console.log(`[System] 🟢 Fake Health Server listening on port ${PORT}`);
});

// ==========================================
// 3. ДВОРНИК (CLEANUP SERVICE)
// ==========================================
const TEMP_DIR = path.join(__dirname, 'temp');

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
        
        // Удаляем файлы старше 60 минут
        if (now - stats.mtimeMs > 3600000) {
           fs.unlink(filePath, (unlinkErr) => {
               if (!unlinkErr) console.log(`[Cleanup] 🗑️ Deleted old file: ${file}`);
           });
        }
      });
    });
  });
}, 1800000); // Каждые 30 минут

// ==========================================
// 4. GRACEFUL SHUTDOWN
// ==========================================
process.on('SIGTERM', async () => {
  console.log('🛑 Worker shutting down...');
  
  // Сначала закрываем HTTP сервер
  server.close(() => {
      console.log('Http server closed.');
  });

  // Потом останавливаем воркер
  if (worker) {
      await worker.close();
  }
  process.exit(0);
});