# ИСПОЛЬЗУЕМ ЛЕГКУЮ ВЕРСИЮ NODE (Debian Bookworm Slim)
FROM node:18-bookworm-slim

# 1. Устанавливаем ТОЛЬКО необходимые системные утилиты
# python3 нужен только для yt-dlp (без pip и torch!)
# ffmpeg нужен для обработки видео
RUN apt-get update && apt-get install -y \
    openssl \
    ca-certificates \
    ffmpeg \
    python3 \
    curl \
    && rm -rf /var/lib/apt/lists/*

# 2. Скачиваем yt-dlp (Загрузчик видео)
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp

# 3. Настройка рабочей папки
WORKDIR /app

# 4. Сначала копируем зависимости (кэширование Docker)
COPY package*.json ./
COPY prisma ./prisma/

# 5. Устанавливаем Node-модули (только для production)
RUN npm install --omit=dev

# 6. Генерируем Prisma Client
RUN npx prisma generate

# 7. Копируем остальной код
COPY . .

# 8. Создаем папку для временных файлов
RUN mkdir -p temp && chmod 777 temp

# 9. Команда запуска
CMD ["npm", "run", "start:worker"]