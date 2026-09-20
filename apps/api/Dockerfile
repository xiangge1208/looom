# =====================================================================
# 后端镜像（NestJS）
#
# 多阶段构建：builder 装全量依赖并编译，runner 只留生产依赖和 dist，
# 镜像体积能小一半以上。
# =====================================================================

FROM node:22-alpine AS builder

WORKDIR /app/apps/api

# 先只拷 package.json，让依赖层能被 Docker 缓存复用，
# 改业务代码时不必重装依赖
COPY apps/api/package.json ./
RUN npm install --no-audit --no-fund

COPY apps/api/tsconfig.json ./
COPY apps/api/src ./src

RUN npx nest build

# ---------------------------------------------------------------------

FROM node:22-alpine AS runner

WORKDIR /app/apps/api

ENV NODE_ENV=production

COPY apps/api/package.json ./
# --omit=dev 只装运行时依赖，不装 @nestjs/cli、typescript 这些
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY --from=builder /app/apps/api/dist ./dist

# 启动时自动建表 + 灌 seed（goal.md 的硬性要求）。
# SQL 文件和初始化脚本都要进镜像 —— 用 Node 执行而非 mysql 客户端，
# 省掉一个 apk 依赖，详见 scripts/init-db.mjs 的说明。
COPY apps/api/scripts/init-db.mjs ./scripts/init-db.mjs
COPY db/schema-01-system.sql db/schema-02-business.sql db/seed.sql /app/db/

# 不用 root 跑，降低容器逃逸的影响面
USER node

EXPOSE 3000

# 先初始化（幂等，失败不阻断），再起服务
CMD ["sh", "-c", "node scripts/init-db.mjs; node dist/main.js"]
