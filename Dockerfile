# Lighthouse UI 분석 서버 (Node + Chromium)
FROM node:20-slim

# Chromium + 한글/이모지 폰트 + 필수 라이브러리
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-liberation fonts-noto-cjk fonts-noto-color-emoji \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# chrome-launcher / puppeteer-core가 컨테이너 Chromium을 사용하도록
ENV CHROME_PATH=/usr/bin/chromium
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV NODE_ENV=production
ENV PORT=3000

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY server.js ./
COPY public ./public

EXPOSE 3000
CMD ["node", "server.js"]
