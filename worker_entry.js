require('dotenv').config();
const { initWorker } = require('./workers/verificationWorker');
const fs = require('fs');
const path = require('path');
const http = require('http');

console.log('[Entry] 🏁 Starting Verification Worker process...');

let worker = null;

// ==========================================
// 1) START WORKER
// ==========================================
try {
  worker = initWorker();
  console.log('[Entry] ✅ Worker initialized');
} catch (e) {
  console.error('[Entry] 💥 Worker failed to start:', e);
  process.exit(1);
}

// ==========================================
// 2) KEEP PORT OPEN FOR RENDER (Web Service on Free)
// ==========================================
const PORT = process.env.PORT || 10000;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Worker is active.');
});

server.listen(PORT, () => {
  console.log(`[System] 🟢 Fake Health Server listening on port ${PORT}`);
});

// ==========================================
// 3) CLEANUP TEMP
// ==========================================
// ✅ Важно: используем process.cwd()/temp — совпадает с Dockerfile (mkdir -p temp)
const TEMP_DIR = path.resolve(process.cwd(), 'temp');

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
      fs.stat(filePath, (stErr, stats) => {
        if (stErr) return;

        // Удаляем старше 60 минут
        if (now - stats.mtimeMs > 60 * 60 * 1000) {
          fs.unlink(filePath, (unlinkErr) => {
            if (!unlinkErr) console.log(`[Cleanup] 🗑️ Deleted old file: ${file}`);
          });
        }
      });
    });
  });
}, 30 * 60 * 1000);

// ==========================================
// 4) GRACEFUL SHUTDOWN
// ==========================================
process.on('SIGTERM', async () => {
  console.log('[Entry] 🛑 Worker shutting down...');

  server.close(() => console.log('[Entry] ✅ Http server closed'));

  try {
    if (worker && typeof worker.close === 'function') {
      await worker.close();
      console.log('[Entry] ✅ Worker closed');
    }
  } catch (e) {
    console.error('[Entry] ⚠️ Error while closing worker:', e);
  }

  process.exit(0);
});
