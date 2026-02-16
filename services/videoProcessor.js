const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

function ensureTempDir() {
  const dir = path.resolve(process.cwd(), 'temp');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function normalizeYoutubeInput(input) {
  const s = String(input || '').trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(s)) {
    return `https://www.youtube.com/watch?v=${s}`;
  }
  return s;
}

// 🍪 УМНАЯ ЗАГРУЗКА КУКОВ (Base64 приоритетнее)
function getCookiesContent() {
  if (process.env.YOUTUBE_COOKIES_B64) {
    try {
      return Buffer.from(process.env.YOUTUBE_COOKIES_B64, 'base64').toString('utf8');
    } catch (e) {
      console.error('[Cookies] ❌ Failed to decode Base64 cookies:', e.message);
    }
  }
  if (process.env.YOUTUBE_COOKIES) {
    return process.env.YOUTUBE_COOKIES;
  }
  return null;
}

async function extractAudio(inputUrl) {
  const url = normalizeYoutubeInput(inputUrl);
  console.log(`[Downloader] ⬇️ Processing: ${url}`);

  const startedAt = Date.now();
  const tempDir = ensureTempDir();
  const uniqueId = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  
  // Мы используем шаблон, но yt-dlp сам подставит расширение wav после конвертации
  const outTemplate = path.join(tempDir, `audio_${uniqueId}.%(ext)s`);
  const expectedWavPath = path.join(tempDir, `audio_${uniqueId}.wav`);
  const cookiesPath = path.join(tempDir, `cookies_${uniqueId}.txt`);

  // 1. Подготовка куков
  const cookiesContent = getCookiesContent();
  const hasCookies = !!cookiesContent;

  if (hasCookies) {
    try {
      fs.writeFileSync(cookiesPath, cookiesContent, { encoding: 'utf8', mode: 0o600 });
      const stats = fs.statSync(cookiesPath);
      const firstLine = cookiesContent.split('\n')[0] || '';
      console.log(`[Cookies] ✅ Loaded. Size: ${stats.size} bytes. Header check: "${firstLine.substring(0, 50)}..."`);
    } catch (e) {
      console.error(`[Cookies] ⚠️ Error writing cookies: ${e.message}`);
    }
  } else {
    console.log(`[Cookies] ⚠️ No cookies found in ENV`);
  }

  // Настройка времени (3 минуты)
  const durationSec = 180;
  const mm = Math.floor(durationSec / 60);
  const ss = durationSec % 60;
  const endTime = `00:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  const timeSection = `*00:00-${endTime}`;

  return new Promise((resolve, reject) => {
    // 🔥 ИСПРАВЛЕННЫЕ АРГУМЕНТЫ (Omnivorous Mode)
    const args = [
      '-f', 'bestvideo+bestaudio/best', // 🔥 ГЛАВНОЕ: Разрешаем скачивать что угодно
      '-x',                             // Извлекаем аудио
      '--audio-format', 'wav',          // Конвертируем в WAV
      '--postprocessor-args', 'ffmpeg:-ac 1 -ar 16000', // Формат для AI (16kHz mono)
      '--download-sections', timeSection,
      '--force-overwrites',
      '--no-playlist',
      '--no-warnings',
      '--no-progress',
      '--geo-bypass',
      '-o', outTemplate
    ];

    if (hasCookies && fs.existsSync(cookiesPath)) {
      args.push('--cookies', cookiesPath);
    }

    if (process.env.PROXY_URL) {
      args.push('--proxy', process.env.PROXY_URL);
    }

    // 🔥 Ссылка ВСЕГДА последняя
    args.push(url);

    // Логируем команду для отладки (скрывая куки)
    // console.log('[Downloader] Command args:', args.filter(a => !a.includes('cookies')));

    const ytDlp = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stderr = '';
    let stdout = '';

    ytDlp.stdout.on('data', (d) => { stdout += d.toString(); });
    ytDlp.stderr.on('data', (d) => { stderr += d.toString(); });

    // Таймаут 3.5 минуты
    const timeoutMs = 210000;
    const timer = setTimeout(() => {
      try {
        console.error(`[TIMEOUT] yt-dlp exceeded ${timeoutMs}ms, killing...`);
        ytDlp.kill('SIGKILL');
      } catch (_) {}
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      if (hasCookies && fs.existsSync(cookiesPath)) {
        try { fs.unlinkSync(cookiesPath); } catch (_) {}
      }
    };

    ytDlp.on('close', (code) => {
      cleanup();

      if (code === 0) {
        // 🔍 УМНЫЙ ПОИСК ФАЙЛА
        let foundPath = null;
        if (fs.existsSync(expectedWavPath)) {
            foundPath = expectedWavPath;
        } else {
            // Если имя файла немного отличается, ищем кандидата
            const candidates = fs.readdirSync(tempDir)
                .filter(f => f.startsWith(`audio_${uniqueId}`) && f.endsWith('.wav'));
            if (candidates.length > 0) {
                foundPath = path.join(tempDir, candidates[0]);
                console.log(`[Downloader] ⚠️ Exact path missing, found candidate: ${foundPath}`);
            }
        }

        if (foundPath && fs.existsSync(foundPath)) {
          const stat = fs.statSync(foundPath);
          if (stat.size < 1024) {
             return reject(new Error(`yt-dlp produced empty file (${stat.size} bytes). Stderr: ${stderr.slice(0, 500)}`));
          }
          const dur = ((Date.now() - startedAt) / 1000).toFixed(2);
          console.log(`[Downloader] ✅ Completed in ${dur}s: ${foundPath}`);
          return resolve(foundPath);
        }
        return reject(new Error(`yt-dlp finished but WAV missing. Stderr: ${stderr.slice(0, 800)} Stdout: ${stdout.slice(0, 300)}`));
      }
      return reject(new Error(`yt-dlp failed (code ${code}). Stderr: ${stderr.slice(0, 1000)} Stdout: ${stdout.slice(0, 300)}`));
    });

    ytDlp.on('error', (err) => {
      cleanup();
      reject(new Error(`Failed to spawn yt-dlp: ${err.message}`));
    });
  });
}

async function performVAD(audioPath) {
  console.log(`[VAD] ⚡ Fast Mode placeholder: ${audioPath}`);
  return [{ start: 0, end: -1 }];
}

module.exports = { extractAudio, performVAD };