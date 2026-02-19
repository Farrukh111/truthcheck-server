FROM node:20-bookworm-slim

# Настройка сети
ENV NODE_OPTIONS=--dns-result-order=ipv4first

# 1. Устанавливаем только интерпретатор Python и FFmpeg
# Мы используем python3-minimal — это самая легкая версия Python
RUN apt-get update && apt-get install -y \
    ca-certificates \
    ffmpeg \
    curl \
    python3-minimal \
    python-is-python3 \
    && rm -rf /var/lib/apt/lists/*

# 2. Скачиваем yt-dlp напрямую
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp

WORKDIR /app

# 3. Копируем файлы зависимостей Node.js
COPY package*.json ./
COPY prisma ./prisma/

RUN npm install --omit=dev
RUN npx prisma generate

# 4. Копируем остальной код
COPY . .

# Создаем папку temp
RUN mkdir -p temp && chmod 777 temp

# Запуск
CMD ["node", "worker_entry.js"]