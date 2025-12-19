# server/Dockerfile

# 1. Используем Linux с Node.js 18
FROM node:18-bookworm-slim

# 2. Устанавливаем системные программы:
# - ffmpeg (для аудио)
# - python3 + pip (для yt-dlp)
# - procps (мониторинг)
# - openssl (нужен для Prisma)
# + Создаем ссылку python -> python3
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

# 4. Копируем зависимости
COPY package*.json ./

# 5. Устанавливаем (без dev-зависимостей)
RUN npm ci --omit=dev

# 6. Копируем весь код (включая папку prisma!)
COPY . .

# 7. Создаем папку для временных файлов
RUN mkdir -p temp && chmod 777 temp

# 8. Генерируем Prisma Client (ОБЯЗАТЕЛЬНЫЙ ШАГ)
RUN npx prisma generate

# 9. Порт и запуск
EXPOSE 5000
CMD ["npm", "run", "start:api"]