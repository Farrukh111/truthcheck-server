# 1. Используем Linux с Node.js 18 (Bookworm - отличный выбор)
FROM node:18-bookworm-slim

# 2. Устанавливаем системные программы:
# - ffmpeg (для аудио)
# - python3 + pip (для VAD и скриптов)
# - procps (мониторинг)
# - openssl (для Prisma)
RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    python3-pip \
    procps \
    ca-certificates \
    openssl \
    && ln -s /usr/bin/python3 /usr/bin/python \
    && rm -rf /var/lib/apt/lists/*

# 3. Рабочая папка
WORKDIR /app

# 4. Копируем package.json (Кэширование слоев Node)
COPY package*.json ./
COPY prisma ./prisma/
# 5. Устанавливаем Node-зависимости
RUN npm install

# === 🔥 НОВОЕ: Устанавливаем Python-библиотеки ===
# Сначала копируем файл требований
COPY requirements.txt ./

# Устанавливаем Torch (CPU-версию, чтобы образ весил мало).
# Флаг --break-system-packages обязателен для Debian Bookworm (иначе pip выдаст ошибку)
RUN pip3 install --no-cache-dir --break-system-packages -r requirements.txt --extra-index-url https://download.pytorch.org/whl/cpu
# =================================================

# 6. Копируем весь остальной код
COPY . .

# 7. Создаем папку temp
RUN mkdir -p temp && chmod 777 temp

# 8. Генерируем Prisma Client
RUN npx prisma generate

# 9. Порт и запуск
EXPOSE 5000
CMD ["npm", "run", "start:api"]