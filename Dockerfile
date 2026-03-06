FROM node:20-bookworm-slim

WORKDIR /app

# 1. Установка зависимостей + openssh-client (чтобы npm не ругался на отсутствие ssh)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-venv \
    ffmpeg \
    git \
    curl \
    ca-certificates \
    openssh-client \
    && rm -rf /var/lib/apt/lists/*

# 2. Настраиваем Python venv
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# 3. Устанавливаем yt-dlp компоненты
RUN pip install --no-cache-dir -U \
    "yt-dlp[default,curl-cffi]" \
    yt-dlp-getpot-jsi

# 4. ФОРСИРУЕМ HTTPS для git и устанавливаем провайдер токенов
RUN git config --global url."https://github.com/".insteadOf ssh://git@github.com/ \
    && npm install -g git+https://github.com/pukkandan/bgutil-ytdlp-pot-provider.git

# 5. Приложение
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY . .

# 6. Prisma и права
RUN npx prisma generate
RUN mkdir -p temp && chmod 777 temp

# 7. Запуск
CMD ["sh", "-c", "bgutil-pot-server --port 4416 & node worker_entry.js"]