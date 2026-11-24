FROM node:24-bookworm-slim AS build

WORKDIR /app

COPY apps/api/package.json ./package.json
RUN npm install

COPY apps/api/tsconfig.json apps/api/nest-cli.json ./
COPY apps/api/src ./src

RUN npm run build

FROM node:24-bookworm-slim

WORKDIR /app

COPY apps/api/package.json ./package.json
RUN npm install --omit=dev

COPY --from=build /app/dist ./dist
COPY apps/api/migrations ./migrations

ENV NODE_ENV=production
ENV PORT=7030

EXPOSE 7030

CMD ["node", "dist/main.js"]
