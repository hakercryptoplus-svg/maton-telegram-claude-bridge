FROM node:22-bookworm

ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    BROWSER_DATA_DIR=/data/browser

WORKDIR /app
COPY package*.json ./
RUN npm install --include=dev
RUN npx playwright install --with-deps chromium

COPY tsconfig.json ./
COPY src ./src
RUN npm run build
RUN npm prune --omit=dev

RUN mkdir -p /data/browser
VOLUME ["/data"]

CMD ["node", "dist/index.js"]
