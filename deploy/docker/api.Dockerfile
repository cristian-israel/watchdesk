FROM node:24-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl ffmpeg \
  && rm -rf /var/lib/apt/lists/*

# MediaMTX (linux amd64)
ARG MEDIAMTX_VERSION=1.11.3
RUN curl -fsSL "https://github.com/bluenviron/mediamtx/releases/download/v${MEDIAMTX_VERSION}/mediamtx_v${MEDIAMTX_VERSION}_linux_amd64.tar.gz" \
  | tar -xz -C /usr/local/bin mediamtx \
  && chmod +x /usr/local/bin/mediamtx

COPY apps/api/package.json ./package.json
COPY apps/api/src ./src

ENV NODE_ENV=production
ENV PORT=7030
ENV WEBRTC_PORT=7031
ENV SOURCE=browser
ENV FFMPEG=/usr/bin/ffmpeg
ENV MEDIAMTX=/usr/local/bin/mediamtx

EXPOSE 7030 7031/tcp 7031/udp

CMD ["node", "src/index.js"]
