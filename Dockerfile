# Runtime utama AWCMS-Mini = Bun (ADR-019).
# Base alpine/musl agar native module (transitif, mis. better-sqlite3 via emdash)
# kompatibel dengan runtime alpine.
FROM oven/bun:1-alpine

RUN apk add --no-cache ca-certificates curl

WORKDIR /app

COPY package.json bun.lock ./

# --production: hanya dependencies (devDependencies tidak dibutuhkan runtime)
# --frozen-lockfile: gagal bila bun.lock tidak sinkron dengan package.json
RUN bun install --production --frozen-lockfile

COPY . .

ENV NODE_ENV=production
ENV PORT=3000
ENV NODE_TLS_REJECT_UNAUTHORIZED=0

EXPOSE 3000

# Server Hono dijalankan oleh Bun (terverifikasi: @hono/node-server jalan di Bun).
CMD ["bun", "server/index.mjs"]
