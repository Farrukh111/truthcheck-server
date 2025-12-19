// server/services/ProxyProvider.js
require('dotenv').config();

// Парсим список прокси из одной строки (разделитель запятая)
// Формат в .env: PROXY_LIST=http://user:pass@ip:port,http://user:pass@ip:port
const proxies = process.env.PROXY_LIST ? process.env.PROXY_LIST.split(',') : [];
let currentIndex = 0;

const ProxyProvider = {
  /**
   * Возвращает следующий прокси из списка (Round-Robin)
   * или null, если прокси не настроены.
   */
  getNextProxy: () => {
    if (proxies.length === 0) return null;
    
    const proxy = proxies[currentIndex];
    // Переходим к следующему, зацикливаем если дошли до конца
    currentIndex = (currentIndex + 1) % proxies.length;
    
    return proxy.trim();
  },

  /**
   * Проверяет, включена ли вообще работа с видео
   * (Дополнительная защита, если нужно отключить видео-ветку)
   */
  isVideoEnabled: () => {
    return process.env.VIDEO_CHECKS_ENABLED === 'true';
  }
};

module.exports = ProxyProvider;