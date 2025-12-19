const path = require('path');
const fs = require('fs');
const fsPromises = require('fs').promises;
const { v4: uuidv4 } = require('uuid');
const ytDlp = require('yt-dlp-exec');

const TEMP_DIR = path.join(__dirname, '../../temp');
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// Получение метаданных
async function getVideoMetadata(url) {
  try {
    const output = await ytDlp(url, {
      dumpJson: true,
      noPlaylist: true,
      skipDownload: true,
      // 🔥 Anti-Block: Используем куки если есть
      cookies: fs.existsSync('./cookies.txt') ? './cookies.txt' : undefined,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
    });
    return {
      duration: output.duration,
      title: output.title
    };
  } catch (e) {
    console.error('[VideoProcessor] Metadata error:', e.message);
    return null;
  }
}

async function cleanupFile(filePath) {
  fs.unlink(filePath, (err) => {
    if (err && err.code !== 'ENOENT') console.error('Cleanup error:', err.message);
  });
}

// 2. Скачивание субтитров (заглушка для совместимости)
async function tryDownloadSubtitles(url) {
    return null; 
}

// 3. УМНАЯ ЗАГРУЗКА (С учетом 10 минут)
async function processVideoSmartly(url) {
  console.log(`[VideoProcessor] Validating video: ${url}`);
  
  // ЭТАП 1: ПРОВЕРКА
  const metadata = await getVideoMetadata(url);
  if (metadata) {
      console.log(`[VideoProcessor] Video duration: ${metadata.duration}s`);
      // ⛔ Лимит 10 минут (600 сек) для экономии и поддержки Shorts
      if (metadata.duration > 600) {
          throw new Error("Видео слишком длинное. Мы проверяем только ролики до 10 минут (Shorts/Reels).");
      }
  }

  // ЭТАП 2: СКАЧИВАНИЕ
  const fileId = uuidv4();
  const outputTemplate = path.join(TEMP_DIR, `${fileId}.%(ext)s`);

  try {
    console.log('[VideoProcessor] 🚀 Downloading audio (First 10 mins)...');
    
    await ytDlp(url, {
      extractAudio: true,
      audioFormat: 'mp3',
      output: outputTemplate,
      noPlaylist: true,
      
      // 🔥 Лимит: 10 минут аудио
      downloadSections: "*00:00-10:00",
      forceKeyframesAtCuts: true,
      
      // Настройки сети
      socketTimeout: 10,
      retries: 3,
      
      // 🔥 Обход блокировок
      cookies: fs.existsSync('./cookies.txt') ? './cookies.txt' : undefined,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
    });

    const files = await fsPromises.readdir(TEMP_DIR);
    const audioFile = files.find(f => f.startsWith(fileId) && f.endsWith('.mp3'));
    
    if (!audioFile) throw new Error('Audio file creation failed');
    
    const fullPath = path.join(TEMP_DIR, audioFile);
    console.log(`[VideoProcessor] Success! File ready: ${fullPath}`);
    
    return {
      filePath: fullPath,
      duration: Math.min(metadata?.duration || 180, 600) 
    };
  } catch (error) {
    console.error('[VideoProcessor] Download Error:', error.message);
    throw error;
  }
}

module.exports = { processVideoSmartly, cleanupFile, tryDownloadSubtitles };