FROM node:22-alpine AS base

RUN corepack enable && corepack prepare pnpm@10.28.0 --activate

WORKDIR /app

COPY pnpm-lock.yaml pnpm-workspace.yaml* .npmrc* package.json ./

RUN pnpm fetch --prod

COPY . .

RUN pnpm install --offline --prod --frozen-lockfile

FROM base AS release

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["node", "server/index.mjs"]
