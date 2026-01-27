# 1. Используем Linux с Node.js 18
FROM node:18-bookworm-slim

# 2. Устанавливаем системные программы:
# ДОБАВИЛ: curl (нужен для скачивания yt-dlp)
RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    python3-pip \
    procps \
    ca-certificates \
    openssl \
    curl \
    && ln -s /usr/bin/python3 /usr/bin/python \
    && rm -rf /var/lib/apt/lists/*

# === 🔥 ВАЖНОЕ ИСПРАВЛЕНИЕ ===
# Скачиваем свежий yt-dlp и даем права на выполнение
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp
# ==============================

# 3. Рабочая папка
WORKDIR /app

# 4. Копируем package.json
COPY package*.json ./
COPY prisma ./prisma/

# 5. Устанавливаем Node-зависимости
RUN npm install

# 6. Устанавливаем Python-библиотеки (ДЛЯ ЭТАПА 0 ОСТАВЛЯЕМ)
COPY requirements.txt ./
# Используем --break-system-packages, так как это Docker и нам все равно на изоляцию системного питона
RUN pip3 install --no-cache-dir --break-system-packages -r requirements.txt --extra-index-url https://download.pytorch.org/whl/cpu

# 7. Копируем весь остальной код
COPY . .

# 8. Создаем папку temp
RUN mkdir -p temp && chmod 777 temp

# 9. Генерируем Prisma Client
RUN npx prisma generate

# 10. Порт
EXPOSE 5000

# ВАЖНО: Render может переопределить эту команду в настройках, но пусть будет дефолт
CMD ["npm", "run", "start:worker"]