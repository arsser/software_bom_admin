# Build stage
FROM node:20-alpine AS builder

RUN corepack enable && corepack prepare pnpm@latest --activate

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
