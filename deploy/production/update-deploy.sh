#!/bin/bash

# 一键更新脚本：先拉取代码，再执行部署脚本
# 用法：
#   ./update-deploy.sh              # 等价于 ./deploy.sh latest
#   ./update-deploy.sh v1.0.5       # 等价于 ./deploy.sh v1.0.5
#   ./update-deploy.sh 1.0.5        # 等价于 ./deploy.sh 1.0.5
#
# pull 后会 exec 自身（带 --skip-pull），确保本脚本被更新后立刻跑新逻辑。
# 用 bash 重新执行，避免仓库未带 +x 时 Permission denied。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SELF="$SCRIPT_DIR/update-deploy.sh"

echo "[update] repo root: $REPO_ROOT"
cd "$REPO_ROOT"

if [[ "${1:-}" != "--skip-pull" ]]; then
  CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
  echo "[update] current branch: $CURRENT_BRANCH"
  echo "[update] running: git pull --ff-only"
  git pull --ff-only
  echo "[update] re-exec after pull: bash $SELF --skip-pull $*"
  exec bash "$SELF" --skip-pull "$@"
fi

shift
echo "[update] running deploy.sh $*"
bash "$SCRIPT_DIR/deploy.sh" "$@"
