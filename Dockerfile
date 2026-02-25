FROM node:20-bookworm-slim

WORKDIR /app
# Устанавливаем python, pip и ffmpeg
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip ffmpeg curl \
    && rm -rf /var/lib/apt/lists/*
# Устанавливаем yt-dlp напрямую из PyPI (всегда свежий релиз)
RUN python3 -m pip install --no-cache-dir -U yt-dlp
# 3. Копируем файлы зависимостей Node.js
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY . .

# 4. Копируем остальной код
COPY . .
# Генерируем Prisma Client после копирования schema.prisma
RUN npx prisma generate

# Гарантируем права на папку temp
RUN mkdir -p temp && chmod 777 temp

# Запуск
CMD ["node", "worker_entry.js"]