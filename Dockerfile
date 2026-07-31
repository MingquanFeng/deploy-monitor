# syntax=docker/dockerfile:1

# ---------- builder ----------
FROM node:20-alpine AS builder

# Next.js/SWC 在 alpine 上需要 glibc 兼容层
RUN apk add --no-cache libc6-compat

WORKDIR /app

# 先只拷依赖清单，让依赖层能被缓存
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# public/ 目前不存在，先兜底创建，保证 runner 阶段的 COPY 不会失败
RUN mkdir -p public

ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ---------- runner ----------
FROM node:20-alpine AS runner

RUN apk add --no-cache libc6-compat

WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
# SQLite 文件落到这里，由 docker-compose 挂命名卷做持久化
ENV DATA_DIR=/app/data

# 非 root 运行
RUN addgroup -g 1001 -S nodejs \
 && adduser  -u 1001 -S nextjs -G nodejs

# standalone 产物自带精简 node_modules 与 server.js
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
# standalone 不含静态资源，必须手动补齐
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

# 必须在镜像里预建并 chown 数据目录：
# Docker 创建命名卷时会继承镜像内该路径的属主/权限，
# 否则卷会是 root:root，非 root 用户写 deploy.db 时 EACCES
RUN mkdir -p /app/data && chown -R nextjs:nodejs /app/data

USER nextjs

EXPOSE 3000

CMD ["node", "server.js"]
