# =====================================================================
# 前端镜像（Vue 3 + Vite → Nginx 静态托管）
# =====================================================================

FROM node:22-alpine AS builder

WORKDIR /app/apps/web

COPY apps/web/package.json ./
RUN npm install --no-audit --no-fund

COPY apps/web/tsconfig.json apps/web/vite.config.ts apps/web/index.html ./
COPY apps/web/src ./src

# 只跑 vite build，跳过 vue-tsc 类型检查：
# 类型检查应在 CI / 本地做，放进镜像构建会拖慢部署且失败点不清晰
RUN npx vite build

# ---------------------------------------------------------------------

FROM nginx:1.27-alpine AS runner

COPY --from=builder /app/apps/web/dist /usr/share/nginx/html
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
