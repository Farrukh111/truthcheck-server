const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

function ensureTempDir() {
  const dir = path.resolve(process.cwd(), 'temp');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ID (Pd_nXM4kP_U) -> https://www.youtube.com/watch?v=...
function normalizeYoutubeInput(input) {
  const s = String(input || '').trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(s)) {
    return `https://www.youtube.com/watch?v=${s}`;
  }
  return s;
}

/**
 * Скачивает первые 3 минуты и конвертит в WAV 16kHz mono.
 * Возвращает ПУТЬ к wav-файлу.
 */
async function extractAudio(inputUrl) {
  const url = normalizeYoutubeInput(inputUrl);
  console.log(`[Downloader] ⬇️ Processing: ${url}`);

  const startedAt = Date.now();
  const tempDir = ensureTempDir();

  const uniqueId = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const outTemplate = path.join(tempDir, `audio_${uniqueId}.%(ext)s`);
  const finalPath = path.join(tempDir, `audio_${uniqueId}.wav`);

  const durationSec = 180;
  const mm = Math.floor(durationSec / 60);
  const ss = durationSec % 60;
  const endTime = `00:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  const timeSection = `*00:00-${endTime}`;

  return new Promise((resolve, reject) => {
    const args = [
      url,
      '-x',
      '--audio-format', 'wav',
      '--postprocessor-args', 'ffmpeg:-ac 1 -ar 16000',
      '--download-sections', timeSection,
      '--force-overwrites',
      '--no-playlist',
      '--no-warnings',
      '--no-progress',
      '-o', outTemplate
    ];

    if (process.env.PROXY_URL) args.push('--proxy', process.env.PROXY_URL);

    const ytDlp = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stderr = '';
    let stdout = '';
    ytDlp.stdout.on('data', (d) => { stdout += d.toString(); });
    ytDlp.stderr.on('data', (d) => { stderr += d.toString(); });

    // Ручной таймаут (spawn сам по себе не гарантирует убийство зависшего процесса)
    const timeoutMs = 210000;
    const timer = setTimeout(() => {
      try {
        console.error(`[TIMEOUT] yt-dlp exceeded ${timeoutMs}ms, killing...`);
        ytDlp.kill('SIGKILL');
      } catch (_) {}
    }, timeoutMs);

    const finish = (err, filePath) => {
      clearTimeout(timer);
      if (err) return reject(err);
      return resolve(filePath);
    };

    ytDlp.on('close', (code) => {
      if (code === 0) {
        if (fs.existsSync(finalPath)) {
          const stat = fs.statSync(finalPath);
          if (stat.size < 1024) {
            return finish(new Error(
              `yt-dlp produced empty/corrupt file (${stat.size} bytes). stdout: ${stdout.slice(0, 300)} stderr: ${stderr.slice(0, 500)}`
            ));
          }
          const dur = ((Date.now() - startedAt) / 1000).toFixed(2);
          console.log(`[Downloader] ✅ Completed in ${dur}s: ${finalPath}`);
          return finish(null, finalPath);
        }
        return finish(new Error(
          `yt-dlp finished but file missing. stdout: ${stdout.slice(0, 300)} stderr: ${stderr.slice(0, 800)}`
        ));
      }
      return finish(new Error(
        `yt-dlp failed (code ${code}). stdout: ${stdout.slice(0, 300)} stderr: ${stderr.slice(0, 1200)}`
      ));
    });

    ytDlp.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Failed to spawn yt-dlp: ${err.message}`));
    });
  });
}

/**
 * Пока заглушка VAD.
 */
async function performVAD(audioPath) {
  console.log(`[VAD] ⚡ Fast Mode placeholder: ${audioPath}`);
  return [{ start: 0, end: -1 }];
}

module.exports = { extractAudio, performVAD };
