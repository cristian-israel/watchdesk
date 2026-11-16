FROM node:24-bookworm-slim AS build

WORKDIR /repo
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

RUN corepack enable && corepack prepare pnpm@11.22.0 --activate

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/web/package.json ./apps/web/package.json
COPY apps/api/package.json ./apps/api/package.json

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

COPY apps/web ./apps/web

RUN pnpm --filter @watchdesk/web build

FROM busybox

COPY --from=build /repo/apps/web/dist /srv
