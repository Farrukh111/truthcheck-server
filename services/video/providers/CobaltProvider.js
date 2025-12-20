// server/services/video/providers/CobaltProvider.js
const BaseProvider = require('./BaseProvider');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { pipeline } = require('stream/promises');

const TEMP_DIR = path.join(__dirname, '../../../temp');

// Используем публичный инстанс (или свой, если поднимете)
const COBALT_API = process.env.COBALT_URL || 'https://api.cobalt.tools/api/json';

class CobaltProvider extends BaseProvider {
  constructor() {
    super('Cobalt API (External)');
  }

  async process(url) {
    try {
      console.log(`[Cobalt] Requesting: ${url}`);
      
      // 🔥 FIX: Упрощенные заголовки и параметры, чтобы не злить API
      const response = await axios.post(COBALT_API, {
        url: url,
        // Когда просим аудио, убираем видео-параметры, иначе API вернет 400
        isAudioOnly: true, 
        aFormat: 'mp3',
        filenamePattern: 'classic'
      }, {
        headers: {
           'Accept': 'application/json',
           'Content-Type': 'application/json',
           // 🔥 FIX: Прикидываемся браузером, а не ботом
           'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
      });

      // Cobalt возвращает разные статусы. Нам нужен 'stream' или 'redirect'
      if (!response.data || !['stream', 'redirect', 'picker'].includes(response.data.status)) {
          console.warn('[Cobalt] API Error / Picker:', response.data);
          // Если Cobalt вернул 'picker' (несколько вариантов), берем первый url
          if (response.data.status === 'picker' && response.data.picker && response.data.picker.length > 0) {
              return await this.downloadStream(response.data.picker[0].url);
          }
          return null;
      }

      return await this.downloadStream(response.data.url);

    } catch (e) {
      // Логируем детали ошибки от Axios
      const status = e.response?.status;
      const data = JSON.stringify(e.response?.data || {});
      console.error(`[Cobalt] Failed (${status}): ${data} - ${e.message}`);
      return null;
    }
  }

  // Вынес скачивание в отдельный метод
  async downloadStream(downloadUrl) {
      const fileId = uuidv4();
      const filePath = path.join(TEMP_DIR, `${fileId}.mp3`);

      console.log(`[Cobalt] Downloading from: ${downloadUrl}`);

      const fileStream = fs.createWriteStream(filePath);
      const dlResponse = await axios.get(downloadUrl, { 
          responseType: 'stream',
          headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
          }
      });
      
      await pipeline(dlResponse.data, fileStream);

      return {
          type: 'audio',
          filePath: filePath,
          cleanup: () => {
              try { fs.unlinkSync(filePath); } catch(e){} 
          }
      };
  }
}

module.exports = CobaltProvider;