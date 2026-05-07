# Build stage
FROM node:20-alpine AS builder

# pnpm 11+ 需 Node ≥22.13 且依赖 node:sqlite；与仓库 lockfile / 根目录 packageManager 一致固定为 9.x
RUN corepack enable && corepack prepare pnpm@9 --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile --ignore-scripts
RUN pnpm rebuild esbuild

COPY . .

ARG VITE_APP_VERSION
ARG VITE_APP_BUILD_TIME
ARG VITE_APP_GIT_SHA

ENV VITE_APP_VERSION=$VITE_APP_VERSION
ENV VITE_APP_BUILD_TIME=$VITE_APP_BUILD_TIME
ENV VITE_APP_GIT_SHA=$VITE_APP_GIT_SHA

RUN pnpm build

# Production stage
FROM nginx:alpine AS production

COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
