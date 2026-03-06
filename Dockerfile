FROM node:20-bookworm-slim

WORKDIR /app
# System dependencies for Node worker + Python yt-dlp stack
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv ffmpeg git \
    && rm -rf /var/lib/apt/lists/*
# Устанавливаем yt-dlp напрямую из PyPI (всегда свежий релиз)
# Python virtual environment for yt-dlp tooling
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# yt-dlp with curl_cffi impersonation support + PO token integration helper
RUN pip install --no-cache-dir -U \
    "yt-dlp[default,curl-cffi]" \
    yt-dlp-getpot-jsi

# Global PO token provider server
RUN curl -L https://github.com/pukkandan/-bgutil-ytdlp-pot-provider/archive/refs/heads/master.tar.gz -o pot-provider.tar.gz \
    && npm install -g ./pot-provider.tar.gz \
    && rm pot-provider.tar.gz



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
CMD ["sh", "-c", "bgutil-pot-server --port 4416 & node worker_entry.js"]