# Stage 1 — install dependencies dengan Bun (package manager).
# Base alpine/musl agar native module (better-sqlite3) kompatibel dengan runtime alpine.
FROM oven/bun:1-alpine AS deps

WORKDIR /app

COPY package.json bun.lock ./

# --production: hanya dependencies (devDependencies tidak dibutuhkan runtime)
# --frozen-lockfile: gagal bila bun.lock tidak sinkron dengan package.json
RUN bun install --production --frozen-lockfile

# Stage 2 — runtime tetap Node (CMD pakai node).
# Migrasi runtime ke Bun direncanakan terpisah (lihat ADR Bun + issue runtime).
FROM node:22-alpine

RUN apk add --no-cache ca-certificates curl

WORKDIR /app

# node_modules yang sudah di-install Bun (native module ter-build untuk alpine/musl)
COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV NODE_ENV=production
ENV PORT=3000
ENV NODE_TLS_REJECT_UNAUTHORIZED=0

EXPOSE 3000

CMD ["node", "./server/index.mjs"]
