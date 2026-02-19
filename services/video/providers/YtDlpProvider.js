const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

class YtDlpProvider {
  constructor() {
    // Путь к cookies.txt (поднимаемся на 4 уровня вверх: video -> providers -> services -> server -> root)
    this.cookiesPath = path.resolve(__dirname, '../../../../cookies.txt');
  }

  /**
   * Общие аргументы для стабильной работы с YouTube на облаках.
   * (моб. клиент + IPv4 + базовые ретраи + no-playlist)
   */
  getCommonYouTubeArgs() {
    return [
      '--no-playlist',

      // ✅ Главный обход "Requested format is not available"
      '--extractor-args',
      'youtube:player_client=ios,mweb;player_skip=webpage',

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
    if (fs.existsSync(this.cookiesPath)) args.push('--cookies', this.cookiesPath);
    if (process.env.PROXY_URL) args.push('--proxy', process.env.PROXY_URL);
    return args;
  }

  /**
   * Получает длительность видео (сек).
   * Используется для быстрой проверки лимита (Fail Fast).
   */
  async getVideoDuration(url) {
    const args = [
      url,
      '--dump-json',     // Только JSON метаданные
      '--skip-download', // Самое важное: не качаем видео
      ...this.getCommonYouTubeArgs(),
    ];

    this.applyAuthAndProxy(args);

    return new Promise((resolve, reject) => {
      // Таймаут 30 секунд на получение инфы
      const proc = spawn('yt-dlp', args, { timeout: 30000 });
      let output = '';
      let stderr = '';

      proc.stdout.on('data', (d) => { output += d.toString(); });
      proc.stderr.on('data', (d) => { stderr += d.toString(); });

      proc.on('close', (code) => {
        if (code === 0) {
          try {
            const json = JSON.parse(output);

            if (!json.duration || typeof json.duration !== 'number') {
              return reject(new Error('VIDEO_DURATION_UNKNOWN'));
            }
            resolve(json.duration);
          } catch (e) {
            reject(new Error(`Failed to parse video metadata. stderr: ${stderr}`));
          }
        } else {
          console.error(`[YtDlp Meta Error]: ${stderr}`);
          reject(new Error(`Failed to get video duration. code=${code}. stderr: ${stderr}`));
        }
      });
    });
  }

  /**
   * Скачивает аудио (WAV 16kHz).
   * Строго ограничивает длину скачивания.
   */
  async downloadAudioSegment(url, outputId, duration = 180) {
    // Путь к temp (поднимаемся на 4 уровня вверх)
    const outputPath = path.resolve(__dirname, '../../../../temp', `${outputId}.wav`);

    // Создаем папку temp, если её нет
    const tempDir = path.dirname(outputPath);
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

    // Конвертация секунд в формат HH:MM:SS
    const minutes = Math.floor(duration / 60);
    const seconds = duration % 60;
    const endTime = `00:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    const timeSection = `*00:00-${endTime}`;

    const args = [
      url,

      // ✅ Универсальный формат (аудио): меньше шансов получить "Requested format..."
      '-f', 'ba/best',

      // Извлечь аудио
      '-x',
      '--audio-format', 'wav',
      '--postprocessor-args', 'ffmpeg:-ar 16000 -ac 1',

      // Качаем только кусок
      '--download-sections', timeSection,
      '--force-overwrites',

      ...this.getCommonYouTubeArgs(),

      // Путь вывода
      '-o', outputPath,
    ];

    this.applyAuthAndProxy(args);

    return new Promise((resolve, reject) => {
      // Таймаут 3.5 минуты (на случай медленного прокси)
      const proc = spawn('yt-dlp', args, { timeout: 210000 });
      let stderr = '';

      proc.stderr.on('data', d => { stderr += d.toString(); });

      proc.on('close', (code) => {
        if (code === 0 && fs.existsSync(outputPath)) {
          resolve(outputPath);
        } else {
          console.error(`[YtDlp Download Error]: ${stderr}`);
          reject(new Error(`yt-dlp failed with code ${code}. stderr: ${stderr}`));
        }
      });
    });
  }
}

module.exports = new YtDlpProvider();
