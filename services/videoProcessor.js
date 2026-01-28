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
      '--quiet',
      '-o', outTemplate
    ];

    if (process.env.PROXY_URL) args.push('--proxy', process.env.PROXY_URL);

    const ytDlp = spawn('yt-dlp', args, { timeout: 210000 });

    let stderr = '';
    ytDlp.stderr.on('data', (d) => { stderr += d.toString(); });

    ytDlp.on('close', (code) => {
      if (code === 0) {
        if (fs.existsSync(finalPath)) {
          const dur = ((Date.now() - startedAt) / 1000).toFixed(2);
          console.log(`[Downloader] ✅ Downloaded in ${dur}s: ${finalPath}`);
          resolve(finalPath);
        } else {
          reject(new Error(`yt-dlp finished but WAV missing at ${finalPath}. Stderr: ${stderr.slice(0, 800)}`));
        }
      } else {
        reject(new Error(`yt-dlp failed (code ${code}). Stderr: ${stderr.slice(0, 800)}`));
      }
    });

    ytDlp.on('error', (err) => reject(new Error(`Failed to spawn yt-dlp: ${err.message}`)));
  });
}

async function performVAD(audioPath) {
  console.log(`[VAD] ⚡ Fast Mode placeholder (no real VAD): ${audioPath}`);
  return new Promise((resolve) => setTimeout(() => resolve([{ start: 0, end: 1000 }]), 50));
}

module.exports = { extractAudio, performVAD };
