FROM node:20-bookworm-slim

# IPv4-first (лечит ENETUNREACH к npm по IPv6 на некоторых сетях)
ENV NODE_OPTIONS=--dns-result-order=ipv4first

RUN apt-get update && apt-get install -y \
    ca-certificates \
    ffmpeg \
    curl \
    openssl \
    python3 \
    python-is-python3 \
    && rm -rf /var/lib/apt/lists/*

# yt-dlp binary
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp

WORKDIR /app

COPY package*.json ./
COPY prisma ./prisma/

RUN npm install --omit=dev
RUN npx prisma generate

COPY . .

RUN mkdir -p temp && chmod 777 temp

CMD ["npm", "run", "start:worker"]
