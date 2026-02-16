FROM node:20-bookworm-slim

# IPv4-first (лечит проблемы с сетью)
ENV NODE_OPTIONS=--dns-result-order=ipv4first

# Установка системных зависимостей
RUN apt-get update && apt-get install -y \
    ca-certificates \
    ffmpeg \
    curl \
    openssl \
    python3 \
    python-is-python3 \
    && rm -rf /var/lib/apt/lists/*

# Установка yt-dlp
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp

WORKDIR /app

# 1. Сначала зависимости (для кэширования)
COPY package*.json ./
COPY prisma ./prisma/

# 2. Установка модулей
RUN npm install --omit=dev
RUN npx prisma generate

# 3. 🔥 ГЛАВНЫЙ ФИКС: ПРИНУДИТЕЛЬНО КОПИРУЕМ ПАПКУ SERVER
COPY server ./server

# 4. Копируем всё остальное (на случай конфигов в корне)
COPY . .

# 5. Создаем папку temp
RUN mkdir -p temp && chmod 777 temp

# Команда по умолчанию
CMD ["node", "server/worker_entry.js"]