FROM node:20-bookworm-slim

WORKDIR /app

# 1) Системные зависимости
# canvas при npm ci часто требует dev-библиотеки, поэтому ставим сразу
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-venv \
    ffmpeg \
    git \
    ca-certificates \
    build-essential \
    libcairo2-dev \
    libpango1.0-dev \
    libjpeg62-turbo-dev \
    libgif-dev \
    librsvg2-dev \
    pkg-config \
    && rm -rf /var/lib/apt/lists/*

# 2) Python venv
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# 3) yt-dlp + plugin
# Актуальный plugin ставим через pip, а не через npm
RUN pip install --no-cache-dir -U \
    "yt-dlp[default,curl-cffi]" \
    bgutil-ytdlp-pot-provider

# 4) Ставим и собираем bgutil provider server по официальной схеме
ARG BGUTIL_VERSION=1.3.0
RUN git clone --single-branch --branch ${BGUTIL_VERSION} https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git /opt/bgutil \
    && cd /opt/bgutil/server \
    && npm ci \
    && npx tsc

# 5) Node.js приложение
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY . .

# 6) Prisma и temp
RUN npx prisma generate
RUN mkdir -p temp && chmod 777 temp

# 7) Переменные окружения
ENV BGUTIL_PORT=4416
ENV NODE_ENV=production

# 8) Запуск:
# - сначала bgutil HTTP server
# - потом твой воркер
CMD ["sh", "-c", "node /opt/bgutil/server/build/main.js --port ${BGUTIL_PORT} & node worker_entry.js"]