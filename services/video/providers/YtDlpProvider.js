const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

class YtDlpProvider {
  constructor() {
    // Путь к cookies.txt (поднимаемся на 4 уровня вверх: video -> providers -> services -> server -> root)
    this.cookiesPath = path.resolve(__dirname, '../../../../cookies.txt');
  }

  /**
   * Получает длительность видео (сек).
   * Используется для быстрой проверки лимита (Fail Fast).
   */
  async getVideoDuration(url) {
    const args = [
      url,
      '--dump-json',       // Только JSON метаданные
      '--no-playlist',
      '--skip-download',   // Самое важное: не качаем видео
      '--quiet',
      '--no-warnings'
    ];

    if (fs.existsSync(this.cookiesPath)) args.push('--cookies', this.cookiesPath);
    // Берем прокси из ENV, так надежнее для MVP
    if (process.env.PROXY_URL) args.push('--proxy', process.env.PROXY_URL);

    return new Promise((resolve, reject) => {
      // Таймаут 30 секунд на получение инфы
      const process = spawn('yt-dlp', args, { timeout: 30000 });
      let output = '';
      let stderr = '';

      // Собираем данные
      process.stdout.on('data', (d) => { output += d.toString(); });
      process.stderr.on('data', (d) => { stderr += d.toString(); });

      process.on('close', (code) => {
        if (code === 0) {
          try {
            const json = JSON.parse(output);
            
            // Если длительность не пришла (например, прямой эфир)
            if (!json.duration || typeof json.duration !== 'number') {
               return reject(new Error('VIDEO_DURATION_UNKNOWN'));
            }
            resolve(json.duration);
          } catch (e) {
            reject(new Error('Failed to parse video metadata'));
          }
        } else {
          console.error(`[YtDlp Meta Error]: ${stderr}`);
          reject(new Error('Failed to get video duration'));
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

    // Конвертация секунд в формат MM:SS для ffmpeg
    const minutes = Math.floor(duration / 60);
    const seconds = duration % 60;
    const endTime = `00:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    const timeSection = `*00:00-${endTime}`; 
    
    const args = [
      url,
      '-x',                                             // Извлечь аудио
      '--audio-format', 'wav',                          // Формат WAV
      '--postprocessor-args', 'ffmpeg:-ar 16000 -ac 1', // Принудительно 16kHz Mono (для Whisper)
      '--download-sections', timeSection,               // Качаем только кусок
      '--force-overwrites',
      '--quiet',
      '--no-warnings',
      '-o', outputPath,
    ];

    if (fs.existsSync(this.cookiesPath)) args.push('--cookies', this.cookiesPath);
    if (process.env.PROXY_URL) args.push('--proxy', process.env.PROXY_URL);

    return new Promise((resolve, reject) => {
      // Таймаут 3.5 минуты (на случай медленного прокси)
      const process = spawn('yt-dlp', args, { timeout: 210000 });
      let stderr = '';
      
      process.stderr.on('data', d => stderr += d);

      process.on('close', (code) => {
        if (code === 0 && fs.existsSync(outputPath)) {
          resolve(outputPath);
        } else {
          console.error(`[YtDlp Download Error]: ${stderr}`);
          reject(new Error(`yt-dlp failed with code ${code}`));
        }
      });
    });
  }
}

module.exports = new YtDlpProvider();