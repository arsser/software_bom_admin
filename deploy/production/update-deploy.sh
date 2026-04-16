#!/bin/bash

# 一键更新脚本：先拉取代码，再执行部署脚本
# 用法：
#   ./update.sh                # 等价于 ./deploy.sh latest
#   ./update.sh v1.0.5         # 等价于 ./deploy.sh v1.0.5
#   ./update.sh 1.0.5          # 等价于 ./deploy.sh 1.0.5

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

echo "[update] repo root: $REPO_ROOT"
cd "$REPO_ROOT"

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
echo "[update] current branch: $CURRENT_BRANCH"
echo "[update] running: git pull --ff-only"
git pull --ff-only

echo "[update] running deploy.sh $*"
"$SCRIPT_DIR/deploy.sh" "$@"

