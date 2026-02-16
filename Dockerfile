FROM node:20-bookworm-slim

# Настройка сети
ENV NODE_OPTIONS=--dns-result-order=ipv4first

# Установка зависимостей (ffmpeg, python, yt-dlp)
RUN apt-get update && apt-get install -y \
    ca-certificates \
    ffmpeg \
    curl \
    openssl \
    python3 \
    python-is-python3 \
    && rm -rf /var/lib/apt/lists/*

RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp

WORKDIR /app

# Копируем package.json из корня
COPY package*.json ./
COPY prisma ./prisma/

RUN npm install --omit=dev
RUN npx prisma generate

# 🔥 КОПИРУЕМ ВСЁ ИЗ КОРНЯ (теперь это сработает, т.к. файлы лежат тут)
COPY . .

# Создаем папку temp
RUN mkdir -p temp && chmod 777 temp

# ✅ ЗАПУСКАЕМ ИЗ КОРНЯ (без server/)
CMD ["node", "worker_entry.js"]