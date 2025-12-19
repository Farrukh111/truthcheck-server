const YtDlpProvider = require('./providers/YtDlpProvider');
const CobaltProvider = require('./providers/CobaltProvider');

class VideoManager {
  constructor() {
    this.providers = [
      new YtDlpProvider(), // 1. Основной (Дешевый/Локальный)
      new CobaltProvider() // 2. Запасной (Для TikTok/Instagram/Shorts)
    ];
  }

  async process(url) {
    let lastError = null;

    // Перебираем провайдеров по очереди
    for (const provider of this.providers) {
      try {
        console.log(`[VideoManager] 🔄 Trying provider: ${provider.name}`);
        const result = await provider.process(url);
        
        if (result) {
            console.log(`[VideoManager] ✅ Success with ${provider.name}`);
            return result;
        }
      } catch (e) {
        console.warn(`[VideoManager] ⚠️ ${provider.name} failed: ${e.message}`);
        lastError = e;
      }
    }

    throw new Error(`Все методы скачивания не сработали. Ссылка может быть недоступна или приватна. (${lastError?.message})`);
  }
}

// Экспортируем единственный инстанс (Singleton)
module.exports = new VideoManager();