FROM node:24-bookworm-slim

WORKDIR /app

COPY apps/api/package.json ./package.json
RUN npm install --omit=dev

COPY apps/api/src ./src
COPY apps/api/migrations ./migrations

ENV NODE_ENV=production
ENV PORT=7030

EXPOSE 7030

CMD ["node", "src/index.js"]
