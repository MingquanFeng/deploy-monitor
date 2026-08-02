# syntax=docker/dockerfile:1

# ---------- builder ----------
# node:22-alpine：better-sqlite3@13 的 engines 要求 node >=22。
# 该包为 linuxmusl-x64 / linuxmusl-arm64 预置了 .node 二进制，
# npm ci 直接落地预编译产物，无需 python3/make/g++ 工具链（已实测）。
FROM node:22-alpine AS builder

# Next.js/SWC 在 alpine 上需要 glibc 兼容层
RUN apk add --no-cache libc6-compat

WORKDIR /app

# 先只拷依赖清单，让依赖层能被缓存
COPY package.json package-lock.json ./
# --ignore-scripts：better-sqlite3 的 .node 二进制已随 npm 包分发
# （prebuilds/linuxmusl-{x64,arm64}.node），装完即可用，无需编译。
# 但 npm 默认会跑其隐式 install 脚本 `node-gyp rebuild`，而 node-gyp 即使最终
# 什么都不编译，也要先用 Python 解析 binding.gyp —— alpine 无 Python，直接失败。
# 跳过脚本比装 python3/make/g++ 更好：镜像少约 200MB，且构建不依赖编译工具链。
# 本项目其余依赖均无需 install 脚本，跳过是安全的。
RUN npm ci --ignore-scripts

COPY . .

# public/ 目前不存在，先兜底创建，保证 runner 阶段的 COPY 不会失败
RUN mkdir -p public

ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# better-sqlite3 为 8 个平台各带一份 .node（约 16MB），运行镜像只需要当前平台那一份。
# lib/binding.js 按 `linuxmusl-${arch}` 拼路径加载，删掉其余平台不影响运行。
# 用 TARGETARCH 而非 uname，保证 buildx 跨平台构建时删的是"非目标平台"而非"非构建平台"。
ARG TARGETARCH
RUN cd .next/standalone/node_modules/better-sqlite3/prebuilds \
 && ls | grep -v "^linuxmusl-${TARGETARCH:-$(node -p 'process.arch')}\.node$" | xargs -r rm -f \
 && echo "kept:" && ls

# ---------- runner ----------
FROM node:22-alpine AS runner

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
