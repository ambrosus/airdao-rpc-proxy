FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY . .

ENV NODE_ENV=production
ENV PORT=6095
ENV PROXY_TO=https://network.ambrosus.io

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost:$PORT/health || exit 1

CMD ["node", "index.js"]

EXPOSE $PORT
