# FairPay app production image (Monad Testnet only). Build from the repo root:
#   docker build -f apps/fairpay/Dockerfile .
# Keys and DATABASE_URL come from the host's secret settings at run time; no .env file is copied in
# (see the root .dockerignore). Data lives in Supabase (DATABASE_URL), including the deposit
# indexer's progress, so it needs no disk and no writable directory (it runs as `node`).
FROM node:24-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/sdk/package.json packages/sdk/
COPY apps/faireats/package.json apps/faireats/
COPY apps/site/package.json apps/site/
COPY apps/fairpay/package.json apps/fairpay/
RUN npm ci --no-audit --no-fund

COPY packages/sdk packages/sdk
COPY packages/contracts/deployments/monadTestnet.json packages/contracts/deployments/monadTestnet.json
COPY apps/fairpay apps/fairpay
RUN npm run build:sdk && npm run build -w fairpay-app && npm run build:server -w fairpay-app

# NODE_ENV=production also makes the server refuse to start without a valid PUBLIC_ORIGIN.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8788
WORKDIR /app/apps/fairpay
EXPOSE 8788
USER node
# The server is bundled into one plain JS file (npm run build:server), so a cold start loads it
# without compiling TypeScript through tsx or reading thousands of module files. On a desktop
# that is about 0.35 s of CPU to the database connect instead of 3.3 s; a free Render instance
# has a tenth of a CPU, so that is the difference between a few seconds and half a minute.
CMD ["node", "dist-server/index.mjs"]
