FROM node:20-bookworm-slim

WORKDIR /app

# 1. Установка системных зависимостей
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-venv \
    ffmpeg \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# 2. Настраиваем Python venv
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# 3. Устанавливаем yt-dlp компоненты
RUN pip install --no-cache-dir -U \
    "yt-dlp[default,curl-cffi]" \
    yt-dlp-getpot-jsi

# 4. Установка провайдера токенов через ТАРБОЛЛ (архив)
# Мы используем прямую ссылку на мастер-ветку. Дефис перед bgutil ВАЖЕН.
RUN npm install -g https://github.com/pukkandan/-bgutil-ytdlp-pot-provider/tarball/master

# 5. Приложение
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY . .

# 6. Prisma и права
RUN npx prisma generate
RUN mkdir -p temp && chmod 777 temp

# 7. Запуск: провайдер токенов на фоне + основной воркер
CMD ["sh", "-c", "bgutil-pot-server --port 4416 & node worker_entry.js"]