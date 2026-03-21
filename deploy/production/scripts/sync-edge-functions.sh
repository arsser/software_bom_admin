#!/usr/bin/env bash
# 同步 Edge Functions 到 Supabase 并重启 functions 服务
# 用法: 在 deploy/production 目录下执行 ./scripts/sync-edge-functions.sh

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# 本脚本位于 deploy/production/scripts，因此仓库根目录为上三级：../../..
REPO_DIR="$(cd -- "${SCRIPT_DIR}/../../.." && pwd)"
DEPLOY_ENV_FILE="${SCRIPT_DIR}/../.deploy.env"

if [ ! -f "$DEPLOY_ENV_FILE" ]; then
  echo "[sync-edge-functions] ERROR: 缺少 $DEPLOY_ENV_FILE（需要配置 SUPABASE_DIR）" >&2
  exit 1
fi

# shellcheck disable=SC1090
source "$DEPLOY_ENV_FILE"

if [ -z "${SUPABASE_DIR:-}" ]; then
  echo "[sync-edge-functions] ERROR: SUPABASE_DIR 未设置（请在 $DEPLOY_ENV_FILE 中配置）" >&2
  exit 1
fi

SRC_DIR="$REPO_DIR/apps/supabase/functions"
DEST_DIR="$SUPABASE_DIR/volumes/functions"

echo "[sync-edge-functions] REPO_DIR     = $REPO_DIR"
echo "[sync-edge-functions] SUPABASE_DIR = $SUPABASE_DIR"
echo "[sync-edge-functions] SRC_DIR      = $SRC_DIR"
echo "[sync-edge-functions] DEST_DIR     = $DEST_DIR"

if [ ! -d "$SRC_DIR" ]; then
  echo "[sync-edge-functions] ERROR: 源目录不存在: $SRC_DIR" >&2
  exit 1
fi

if [ ! -f "$SUPABASE_DIR/docker-compose.yml" ]; then
  echo "[sync-edge-functions] ERROR: 未在 $SUPABASE_DIR 找到 docker-compose.yml" >&2
  exit 1
fi

mkdir -p "$DEST_DIR"

# Supabase 自建的 edge-runtime 需要 volumes/functions/main/index.ts 作为入口。
# 同步自定义函数时必须保留 main/ 目录；若缺失则创建一个最小入口，避免启动失败。
if [ ! -f "$DEST_DIR/main/index.ts" ]; then
  echo "[sync-edge-functions] WARNING: 未找到 $DEST_DIR/main/index.ts，正在创建最小入口（用于保证 edge-runtime 可启动）..."
  mkdir -p "$DEST_DIR/main"
  cat > "$DEST_DIR/main/index.ts" <<'EOF'
Deno.serve(() => new Response("OK", { status: 200, headers: { "content-type": "text/plain" } }));
EOF
fi

if command -v rsync >/dev/null 2>&1; then
  echo "[sync-edge-functions] 使用 rsync 同步..."
  rsync -av --delete --exclude 'main/' "$SRC_DIR/" "$DEST_DIR/"
else
  echo "[sync-edge-functions] 使用 cp 同步..."
  # 不删除 main/（edge-runtime 必需）
  find "$DEST_DIR" -mindepth 1 -maxdepth 1 ! -name 'main' -exec rm -rf {} +
  cp -a "$SRC_DIR/." "$DEST_DIR/"
fi

echo "[sync-edge-functions] 同步完成。"
ls -R "$DEST_DIR" || true

cd "$SUPABASE_DIR"
echo "[sync-edge-functions] 重启 functions 服务..."
docker compose up -d functions
docker compose ps functions
echo "[sync-edge-functions] 完成。"
