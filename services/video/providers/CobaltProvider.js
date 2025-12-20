// server/services/video/providers/CobaltProvider.js
const BaseProvider = require('./BaseProvider');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { pipeline } = require('stream/promises');

const TEMP_DIR = path.join(__dirname, '../../../temp');

// 🔥 СПИСОК СЕРВЕРОВ (Если один лежит, пробуем другой)
const COBALT_INSTANCES = [
  'https://api.cobalt.tools/api/json',       // Официальный (иногда строгий)
  'https://cobalt.api.kwiatekmiki.pl/api/json', // Запасной 1
  'https://api.dl.shadows.gay/api/json'      // Запасной 2
];

class CobaltProvider extends BaseProvider {
  constructor() {
    super('Cobalt API (External)');
  }

  async process(url) {
    // 1. Очищаем ссылку от мусора (?si=...)
    const cleanUrl = url.split('?')[0]; 
    console.log(`[Cobalt] 🧹 Cleaned URL: ${cleanUrl}`);

    // 2. Перебираем сервера по очереди
    for (const apiBase of COBALT_INSTANCES) {
      try {
        console.log(`[Cobalt] 🔄 Trying server: ${apiBase}`);
        
        const response = await axios.post(apiBase, {
          url: cleanUrl,
          // Простой конфиг, который работает везде
          vQuality: "144",
          isAudioOnly: true,
          filenamePattern: "classic"
        }, {
          headers: {
             'Accept': 'application/json',
             'Content-Type': 'application/json',
             'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36'
          },
          timeout: 10000 // Ждем максимум 10 сек
        });

        // Проверяем ответ
        const data = response.data;
        if (!data) throw new Error("Empty response");

        // Если сервер вернул прямую ссылку (stream) или redirect
        if (['stream', 'redirect'].includes(data.status)) {
            return await this.downloadStream(data.url);
        }
        
        // Если сервер вернул 'picker' (выбор), берем аудио
        if (data.status === 'picker' && data.picker) {
            const audioItem = data.picker.find(p => p.type === 'audio') || data.picker[0];
            if (audioItem) return await this.downloadStream(audioItem.url);
        }

        console.warn(`[Cobalt] ⚠️ Server ${apiBase} returned status: ${data.status}`);

      } catch (e) {
        // Логируем ошибку, но НЕ останавливаемся — идем к следующему серверу
        const errorDetails = e.response?.data ? JSON.stringify(e.response.data) : e.message;
        console.warn(`[Cobalt] ❌ Failed on ${apiBase}: ${errorDetails}`);
      }
    }

    console.error('[Cobalt] 💀 All instances failed.');
    return null;
  }

  async downloadStream(downloadUrl) {
      const fileId = uuidv4();
      const filePath = path.join(TEMP_DIR, `${fileId}.mp3`);

      console.log(`[Cobalt] ⬇️ Downloading file...`);

      const fileStream = fs.createWriteStream(filePath);
      const dlResponse = await axios.get(downloadUrl, { 
          responseType: 'stream',
          headers: { 'User-Agent': 'Mozilla/5.0' } // Важно для скачивания
      });
      
      await pipeline(dlResponse.data, fileStream);

      console.log(`[Cobalt] ✅ Download success: ${filePath}`);
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