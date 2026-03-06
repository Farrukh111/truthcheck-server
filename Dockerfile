FROM node:20-bookworm-slim

WORKDIR /app

# 1. Системные зависимости (ffmpeg для звука, git для плагинов)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-venv \
    ffmpeg \
    git \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# 2. Python окружение
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# 3. Установка yt-dlp со всеми обходами
RUN pip install --no-cache-dir -U \
    "yt-dlp[default,curl-cffi]" \
    yt-dlp-getpot-jsi

# 4. Установка провайдера токенов (БЕЗ лишнего дефиса в названии)
RUN npm install -g https://github.com/pukkandan/bgutil-ytdlp-pot-provider.git

# 5. Приложение
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY . .

# 6. Prisma и папки
RUN npx prisma generate
RUN mkdir -p temp && chmod 777 temp

# 7. Запуск двух процессов одновременно
CMD ["sh", "-c", "bgutil-pot-server --port 4416 & node worker_entry.js"]