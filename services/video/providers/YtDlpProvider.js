const BaseProvider = require('./BaseProvider');
const ytDlp = require('yt-dlp-exec');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
// Убедитесь, что ProxyProvider.js лежит в server/services/
const ProxyProvider = require('../../ProxyProvider'); 

// Путь к папке temp (на 3 уровня выше: providers -> video -> services -> server -> temp)
const TEMP_DIR = path.join(__dirname, '../../../temp');

if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

class YtDlpProvider extends BaseProvider {
  constructor() {
    super('yt-dlp (Local)');
  }

  getOptions() {
    const options = {
      noPlaylist: true,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
    };
    
    // 1. Прокси
    const proxy = ProxyProvider.getNextProxy();
    if (proxy) options.proxy = proxy;

    // 2. Cookies (Файл cookies.txt должен лежать в корне server)
    // providers -> video -> services -> server -> cookies.txt
    const cookiePath = path.join(__dirname, '../../../cookies.txt');
    if (fs.existsSync(cookiePath)) {
        options.cookies = cookiePath;
    }

    return options;
  }

  async getMetadata(url) {
    try {
      const output = await ytDlp(url, {
        ...this.getOptions(),
        dumpJson: true,
        skipDownload: true
      });
      return { duration: output.duration, title: output.title, source: 'yt-dlp' };
    } catch (e) {
      console.warn(`[YtDlp] Metadata failed: ${e.message}`);
      return null;
    }
  }

  async process(url) {
    const fileId = uuidv4();
    const outputTemplate = path.join(TEMP_DIR, `${fileId}.%(ext)s`);

    try {
      // 1. Пробуем скачать СУБТИТРЫ
      try {
        await ytDlp(url, {
          ...this.getOptions(),
          skipDownload: true,
          writeAutoSub: true,
          writeSub: true,
          subLang: 'ru,en',
          output: path.join(TEMP_DIR, `${fileId}`),
        });

        // Ищем скачанный файл (.vtt или .srt)
        const files = fs.readdirSync(TEMP_DIR);
        const sub = files.find(f => f.startsWith(fileId) && (f.endsWith('.vtt') || f.endsWith('.srt')));
        
        if (sub) {
            const subPath = path.join(TEMP_DIR, sub);
            const content = fs.readFileSync(subPath, 'utf-8');
            
            // Чистим мусор VTT
            const cleanContent = content
               .replace(/WEBVTT/g, '')
               .replace(/NOTE .*/g, '')
               .replace(/-->.*/g, '')
               .replace(/\d{2}:\d{2}.*/g, '')
               .replace(/<[^>]*>/g, '')
               .trim();

            if (cleanContent.length > 50) {
               return { 
                   type: 'text', 
                   content: cleanContent, 
                   cleanup: () => { try { fs.unlinkSync(subPath) } catch(e){} } 
               };
            }
        }
      } catch (err) {
        // Ошибки субтитров игнорируем, идем качать аудио
        console.log('[YtDlp] Subtitles not found, downloading audio...');
      }

      // 2. Качаем АУДИО (если сабов нет)
      await ytDlp(url, {
        ...this.getOptions(),
        extractAudio: true,
        audioFormat: 'mp3',
        output: outputTemplate,
        downloadSections: "*00:00-03:00", // Лимит 3 мин
        forceKeyframesAtCuts: true,
      });

      const files = fs.readdirSync(TEMP_DIR);
      const audio = files.find(f => f.startsWith(fileId) && f.endsWith('.mp3'));
      
      if (audio) {
          const audioPath = path.join(TEMP_DIR, audio);
          return { 
              type: 'audio', 
              filePath: audioPath, 
              cleanup: () => { try { fs.unlinkSync(audioPath) } catch(e){} } 
          };
      }
      
      throw new Error('Audio file missing after download');

    } catch (e) {
      console.error(`[YtDlp] Process failed: ${e.message}`);
      return null;
    }
  }
}

module.exports = YtDlpProvider;