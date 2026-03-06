FROM node:20-bookworm-slim

WORKDIR /app

# 1. Сначала устанавливаем ВСЕ системные зависимости, включая curl и git
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-venv \
    ffmpeg \
    git \
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

# 4. Теперь curl ТОЧНО есть в системе, скачиваем провайдер токенов
RUN curl -L https://github.com/pukkandan/-bgutil-ytdlp-pot-provider/archive/refs/heads/master.tar.gz -o pot-provider.tar.gz \
    && npm install -g ./pot-provider.tar.gz \
    && rm pot-provider.tar.gz

# 5. Копируем файлы проекта и устанавливаем зависимости Node.js
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY . .

# 6. Prisma и права
RUN npx prisma generate
RUN mkdir -p temp && chmod 777 temp

# 7. Запуск
CMD ["sh", "-c", "bgutil-pot-server --port 4416 & node worker_entry.js"]