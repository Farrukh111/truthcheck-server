// server/services/video/providers/YtDlpProvider.js
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

class YtDlpProvider {
  constructor() {
    // cookies.txt лежит в корне репо (поднимаемся на 4 уровня: video -> providers -> services -> server -> root)
    this.cookiesPath = path.resolve(__dirname, '../../../../cookies.txt');
  }

  /**
   * Общие аргументы для стабильной работы с YouTube на облаках.
   * (моб. клиент + iOS UA + IPv4 + ретраи + no-playlist)
   */
  getCommonYouTubeArgs() {
    return [
      '--no-playlist',

      // ✅ Главный обход "Requested format is not available"
      '--extractor-args',
      'youtube:player_client=ios,mweb;player_skip=webpage',

      // ✅ Консистентный iOS User-Agent (важно вместе с ios,mweb)
      '--user-agent',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',

      // ✅ Часто помогает на облачных хостингах
      '--force-ipv4',

      // ✅ Устойчивость
      '--retries', '3',
      '--fragment-retries', '3',
      '--retry-sleep', '1',

      '--quiet',
      '--no-warnings',
    ];
  }

  /**
   * Добавляет cookies/proxy, если они доступны.
   */
  applyAuthAndProxy(args) {
    if (fs.existsSync(this.cookiesPath)) {
      args.push('--cookies', this.cookiesPath);
    }
    if (process.env.PROXY_URL) {
      args.push('--proxy', process.env.PROXY_URL);
    }
    return args;
  }

  /**
   * Универсальный запуск yt-dlp с нормальным таймаутом (spawn не имеет "timeout" как exec).
   */
  runYtDlp(args, timeoutMs = 120000) {
    const finalArgs = this.applyAuthAndProxy([...args]);

    return new Promise((resolve, reject) => {
      const proc = spawn('yt-dlp', finalArgs, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      const killTimer = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch (_) {}
        reject(new Error(`yt-dlp timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      proc.stdout.on('data', (d) => { stdout += d.toString(); });
      proc.stderr.on('data', (d) => { stderr += d.toString(); });

      proc.on('error', (err) => {
        clearTimeout(killTimer);
        reject(new Error(`Failed to start yt-dlp: ${err.message}`));
      });

      proc.on('close', (code) => {
        clearTimeout(killTimer);

        if (code === 0) {
          resolve({ stdout, stderr });
        } else {
          reject(new Error(`yt-dlp failed (code ${code}). stderr: ${stderr}`));
        }
      });
    });
  }

  /**
   * Получает длительность видео (сек).
   * Используется для быстрой проверки лимита (Fail Fast).
   */
  async getVideoDuration(url) {
    const args = [
      '--dump-json',
      '--skip-download',
      ...this.getCommonYouTubeArgs(),
      url,
    ];

    try {
      const { stdout } = await this.runYtDlp(args, 30000);
      const data = JSON.parse(stdout);
      return typeof data.duration === 'number' ? data.duration : 0;
    } catch (err) {
      console.error('[YtDlp] Error getting duration:', err.message);
      return 0;
    }
  }

  /**
   * Скачивает аудио (WAV 16kHz) кусочком с начала.
   * duration — сколько секунд качать (по умолчанию 180).
   * Есть fallback: если bestaudio не доступен, пробуем best.
   */
  async downloadAudioSegment(url, outputId, duration = 180) {
    const outputPath = path.resolve(__dirname, '../../../../temp', `${outputId}.wav`);

    // Создаем папку temp, если её нет
    const tempDir = path.dirname(outputPath);
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

    // Конвертация секунд в формат HH:MM:SS
    const minutes = Math.floor(duration / 60);
    const seconds = duration % 60;
    const endTime = `00:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    const timeSection = `*00:00-${endTime}`;

    const baseArgs = [
      // Качаем только кусок
      '--download-sections', timeSection,
      '--force-overwrites',

      // Извлечь аудио
      '-x',
      '--audio-format', 'wav',
      '--postprocessor-args', 'ffmpeg:-ar 16000 -ac 1',

      // Общие аргументы
      ...this.getCommonYouTubeArgs(),

      // Путь вывода
      '-o', outputPath,

      // URL в конце — так стабильнее
      url,
    ];

    // Попытка 1: bestaudio/best
    try {
      console.log('[YtDlp] Attempting primary download (bestaudio)...');
      await this.runYtDlp(['-f', 'bestaudio/best', ...baseArgs], 210000);

      if (!fs.existsSync(outputPath)) {
        throw new Error('Output file missing after yt-dlp success');
      }

      return outputPath;
    } catch (err) {
      console.warn('[YtDlp] Primary format failed, trying fallback (best)...', err.message);
    }

    // Попытка 2: best
    try {
      await this.runYtDlp(['-f', 'best', ...baseArgs], 210000);

      if (!fs.existsSync(outputPath)) {
        throw new Error('Output file missing after yt-dlp success (fallback)');
      }

      return outputPath;
    } catch (fallbackErr) {
      console.error('[YtDlp] Fallback download failed:', fallbackErr.message);
      throw new Error(`All download attempts failed: ${fallbackErr.message}`);
    }
  }
}

module.exports = new YtDlpProvider();