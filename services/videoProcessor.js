const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

/**
 * Создает папку temp, если её нет
 */
function ensureTempDir() {
  const dir = path.resolve(process.cwd(), 'temp');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Превращает ID видео в полную ссылку (если пришел просто ID)
 */
function normalizeYoutubeInput(input) {
  const s = String(input || '').trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(s)) {
    return `https://www.youtube.com/watch?v=${s}`;
  }
  return s;
}

/**
 * Получает содержимое куков из ENV (Base64 или текст)
 */
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
function validateCookies(content) {
  const trimmed = String(content).trim();
  if (!trimmed.startsWith('# Netscape HTTP Cookie File')) {
    console.error('[Cookies] ❌ Ошибка формата: файл должен начинаться с "# Netscape HTTP Cookie File"');
    return false;
  }
  return true;
}



/**
 * Главная функция скачивания
 */
async function extractAudio(inputUrl) {
  const url = normalizeYoutubeInput(inputUrl);
  console.log(`[Downloader] ⬇️ Processing: ${url}`);

  const startedAt = Date.now();
  const tempDir = ensureTempDir();
  // Уникальное имя файла
  const uniqueId = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  
  // Шаблон вывода (yt-dlp добавит .wav сам)
  const outTemplate = path.join(tempDir, `audio_${uniqueId}.%(ext)s`);
  const expectedWavPath = path.join(tempDir, `audio_${uniqueId}.wav`);
  const cookiesPath = path.join(tempDir, `cookies_${uniqueId}.txt`);

  // 1. Подготовка куков
  const cookiesContent = getCookiesContent();
  const hasCookies = !!cookiesContent;

  if (hasCookies) {
    if (validateCookies(cookiesContent)) {
      try {
        fs.writeFileSync(cookiesPath, cookiesContent, { encoding: 'utf8', mode: 0o600 });
        const stats = fs.statSync(cookiesPath);
        console.log(`[Cookies] ✅ Успешно сохранены. Размер: ${stats.size} байт.`);
      } catch (e) {
        console.error(`[Cookies] ⚠️ Ошибка записи: ${e.message}`);
      }
    } else {
      console.warn('[Cookies] ⚠️ Куки проигнорированы из-за неверного формата. Запрос пойдет как анонимный.');
    }
  } else {
    console.log(`[Cookies] ⚠️ No cookies found in ENV (may fail on restricted videos)`);
  }

  // Ограничиваем длину (первые 3 минуты), чтобы не забить диск
  const timeSection = `*00:00-03:00`;

  return new Promise((resolve, reject) => {
    // 🔥 ФИНАЛЬНЫЕ АРГУМЕНТЫ (AUDIO ONLY MODE)
    const args = [
      '-f', 'bestaudio/best',           // 1. Ищем лучшее аудио (игнорируем видео)
      '--extract-audio',                // 2. Извлекаем звук
      '--audio-format', 'wav',          // 3. Конвертируем в WAV
      '--audio-quality', '0',           // 4. Лучшее качество
      // 5. Пост-обработка FFmpeg: 16000 Hz, Моно (идеально для AI)
      '--postprocessor-args', 'ffmpeg:-ac 1 -ar 16000', 
      '--js-runtimes', 'node',
      '--extractor-args', 
      'youtube:player_client=ios,mweb;player_skip=webpage',
      '--no-check-certificate',
      '--download-sections', timeSection, // Качаем только фрагмент
      '--force-overwrites',
      '--no-playlist',
      '--no-warnings',
      '--no-progress',
      '--geo-bypass',                     // Обход гео-блоков
      '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
      '-o', outTemplate
    ];

    // Добавляем куки, если есть
    if (hasCookies && fs.existsSync(cookiesPath)) {
      args.push('--cookies', cookiesPath);
    }

    // Добавляем прокси, если есть
    if (process.env.PROXY_URL) {
      args.push('--proxy', process.env.PROXY_URL);
    }

    // URL всегда последний
    args.push(url);

    // Запуск процесса
    const ytDlp = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stderr = '';
    let stdout = '';

    ytDlp.stdout.on('data', (d) => { stdout += d.toString(); });
    ytDlp.stderr.on('data', (d) => { stderr += d.toString(); });

    // Таймаут 3.5 минуты (на всякий случай)
    const timeoutMs = 210000;
    const timer = setTimeout(() => {
      try {
        console.error(`[TIMEOUT] yt-dlp exceeded ${timeoutMs}ms, killing...`);
        ytDlp.kill('SIGKILL');
      } catch (_) {}
    }, timeoutMs);

    // Очистка после завершения
    const cleanup = () => {
      clearTimeout(timer);
      if (hasCookies && fs.existsSync(cookiesPath)) {
        try { fs.unlinkSync(cookiesPath); } catch (_) {}
      }
    };

    ytDlp.on('close', (code) => {
      cleanup();

      if (code === 0) {
        // Проверяем, создался ли файл
        let foundPath = null;
        if (fs.existsSync(expectedWavPath)) {
            foundPath = expectedWavPath;
        } else {
            // Иногда yt-dlp добавляет ID в имя файла, ищем похожий
            const candidates = fs.readdirSync(tempDir)
                .filter(f => f.startsWith(`audio_${uniqueId}`) && f.endsWith('.wav'));
            if (candidates.length > 0) {
                foundPath = path.join(tempDir, candidates[0]);
                console.log(`[Downloader] ⚠️ Exact path missing, found candidate: ${foundPath}`);
            }
        }

        if (foundPath && fs.existsSync(foundPath)) {
          const stat = fs.statSync(foundPath);
          // Защита от пустых файлов
          if (stat.size < 1024) {
             return reject(new Error(`yt-dlp produced empty file (${stat.size} bytes). Stderr: ${stderr.slice(0, 500)}`));
          }
          
          const dur = ((Date.now() - startedAt) / 1000).toFixed(2);
          console.log(`[Downloader] ✅ Completed in ${dur}s: ${foundPath}`);
          return resolve(foundPath);
        }
        return reject(new Error(`yt-dlp finished but WAV missing. Stderr: ${stderr.slice(0, 800)}`));
      }
      return reject(new Error(`yt-dlp failed (code ${code}). Stderr: ${stderr.slice(0, 1000)}`));
    });

    ytDlp.on('error', (err) => {
      cleanup();
      reject(new Error(`Failed to spawn yt-dlp: ${err.message}`));
    });
  });
}

/**
 * Заглушка для VAD (чтобы не упасть по памяти на Python скрипте)
 * Возвращает "весь файл" как полезный сегмент.
 */
async function performVAD(audioPath) {
  console.log(`[VAD] ⚡ Passthrough Mode (Processing whole file): ${audioPath}`);
  return [{ start: 0, end: -1 }];
}

module.exports = { extractAudio, performVAD };