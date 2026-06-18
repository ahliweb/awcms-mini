# Runtime utama AWCMS-Mini = Bun (ADR-019).
#
# Stage `deps`: install dependencies + kompilasi native module.
# better-sqlite3 (transitif via emdash) tidak punya prebuilt untuk ABI Bun+musl,
# sehingga node-gyp mengompilasinya dari source → butuh toolchain (python3/make/g++).
# Toolchain hanya ada di stage ini agar image runtime tetap lean.
FROM oven/bun:1-alpine AS deps

RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package.json bun.lock ./

# --production: hanya dependencies (devDependencies tidak dibutuhkan runtime)
# --frozen-lockfile: gagal bila bun.lock tidak sinkron dengan package.json
RUN bun install --production --frozen-lockfile

# Stage runtime: base bun:1-alpine yang sama (musl-match) tanpa toolchain build.
FROM oven/bun:1-alpine

RUN apk add --no-cache ca-certificates curl

WORKDIR /app

# node_modules (termasuk better-sqlite3.node musl) dari stage deps.
COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV NODE_ENV=production
ENV PORT=3000
ENV NODE_TLS_REJECT_UNAUTHORIZED=0

EXPOSE 3000

# Server Hono dijalankan oleh Bun (terverifikasi: @hono/node-server jalan di Bun).
CMD ["bun", "server/index.mjs"]
