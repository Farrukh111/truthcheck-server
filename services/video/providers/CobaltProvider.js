const BaseProvider = require('./BaseProvider');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { pipeline } = require('stream/promises');

const TEMP_DIR = path.join(__dirname, '../../../temp');

// Публичный инстанс Cobalt. Для продакшна замените на свой (https://github.com/imputnet/cobalt)
const COBALT_API = process.env.COBALT_URL || 'https://api.cobalt.tools/api/json'; 

class CobaltProvider extends BaseProvider {
  constructor() {
    super('Cobalt API (External)');
  }

  async process(url) {
    try {
      console.log(`[Cobalt] Requesting: ${url}`);
      
      const response = await axios.post(COBALT_API, {
        url: url,
        vCodec: 'h264',
        vQuality: '480',
        aFormat: 'mp3',
        isAudioOnly: true // Просим сразу аудио
      }, {
        headers: {
           'Accept': 'application/json',
           'User-Agent': 'TruthCheck-Bot/1.0'
        }
      });

      // Cobalt может вернуть 'stream', 'redirect' или 'picker'
      if (!response.data || (response.data.status !== 'stream' && response.data.status !== 'redirect')) {
          console.warn('[Cobalt] API response invalid:', response.data);
          return null;
      }

      const downloadUrl = response.data.url;
      const fileId = uuidv4();
      const filePath = path.join(TEMP_DIR, `${fileId}.mp3`);

      console.log(`[Cobalt] Downloading from: ${downloadUrl}`);

      // Скачиваем файл стримом
      const fileStream = fs.createWriteStream(filePath);
      const dlResponse = await axios.get(downloadUrl, { responseType: 'stream' });
      
      await pipeline(dlResponse.data, fileStream);

      return {
          type: 'audio',
          filePath: filePath,
          cleanup: () => {
              try { fs.unlinkSync(filePath); } catch(e){} 
          }
      };

    } catch (e) {
      console.error(`[Cobalt] Failed: ${e.message}`);
      return null;
    }
  }
}

module.exports = CobaltProvider;