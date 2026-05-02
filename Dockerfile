FROM node:22-alpine

RUN apk add --no-cache ca-certificates

WORKDIR /app

COPY package.json pnpm-lock.yaml ./

RUN npm install -g pnpm@10.28.0 && pnpm install --prod --frozen-lockfile

COPY . .

ENV NODE_ENV=production
ENV PORT=3000
ENV NODE_TLS_REJECT_UNAUTHORIZED=0

EXPOSE 3000

CMD ["pnpm", "start:api"]
