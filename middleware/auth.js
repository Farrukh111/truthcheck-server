// server/middleware/auth.js
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

module.exports = async (req, res, next) => {
  try {
    // 🔥 Читаем x-device-id вместо Authorization
    const deviceId = req.headers['x-device-id'];

    if (!deviceId) {
      console.warn('[Auth] 🛑 Blocked: No Device ID');
      return res.status(401).json({ error: 'Device ID required' });
    }

    // Ищем или создаем пользователя
    // Используем upsert, чтобы не было дублей
    const user = await prisma.user.upsert({
      where: { id: deviceId },
      update: {}, // Если есть - ничего не меняем
      create: { 
        id: deviceId,
        email: `mobile_${deviceId.substring(0,6)}@truthcheck.ai` 
      }
    });

    // Сохраняем юзера в запрос
    req.user = user;
    next();

  } catch (error) {
    console.error('[Auth] Error:', error);
    res.status(500).json({ error: 'Authentication failed' });
  }
};