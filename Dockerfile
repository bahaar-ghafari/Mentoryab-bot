# ── deps: install everything (needed for prisma generate) ────────────────────
FROM node:22-alpine AS deps
WORKDIR /app
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci

# ── builder: compile TypeScript ───────────────────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate && npm run build

# ── runtime: lean production image ───────────────────────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /app

COPY package*.json ./
COPY prisma ./prisma
# prod deps only, then regenerate Prisma client for this platform
RUN npm ci --omit=dev && npx prisma generate

COPY --from=builder /app/dist ./dist

EXPOSE 3000

# migrate then start; DATABASE_URL comes from env_file at runtime
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/index.js"]
