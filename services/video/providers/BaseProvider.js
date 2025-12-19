class BaseProvider {
  constructor(name) {
    this.name = name;
  }

  /**
   * Возвращает { duration, title, source } или null
   */
  async getMetadata(url) {
    throw new Error('Method not implemented');
  }

  /**
   * Возвращает:
   * { type: 'text', content: string, cleanup: func } 
   * ИЛИ 
   * { type: 'audio', filePath: string, cleanup: func }
   */
  async process(url) {
    throw new Error('Method not implemented');
  }
}

module.exports = BaseProvider;