FROM node:18-alpine

RUN apk add --no-cache dumb-init curl

RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production && npm cache clean --force

COPY --chown=nodejs:nodejs . .

USER nodejs

ENV NODE_ENV=production
ENV PORT=6095

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:${PORT}/health || exit 1

EXPOSE $PORT

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "index.js"]