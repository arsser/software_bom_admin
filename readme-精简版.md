# software_bom_admin 操作速查（精简）

## 本地调试

### 1. Supabase

```bash
cd apps/supabase
pnpm exec supabase start
```

### 2. 数据库迁移（保留数据）

```bash
cd apps/supabase
pnpm exec supabase migration up
```

```bash
pnpm exec supabase migration list
```

### 3. Seed（默认登录账号）

1. 进入 Supabase 管理页面（SQL Editor）。
2. 打开并复制 `apps/supabase/seed.sql`（等价 `deploy/production/scripts/seed.sql`）全部内容。
3. 在 SQL Editor 执行。

web默认账号：`test@example.com` / `test123456`

### 4. Worker

```bash
cp apps/bom-scanner-worker/.env.example apps/bom-scanner-worker/.env
# 按 apps/bom-scanner-worker/.env.example 注释填写 .env

cd apps/bom-scanner-worker
npm run start:env
```

### 5. Edge Function

```bash
cd apps/supabase
pnpm exec supabase functions serve artifactory-api-info --no-verify-jwt
```

### 6. Web

```bash
cp apps/web/public/app-config.js.example apps/web/public/app-config.js
# 编辑 apps/web/public/app-config.js：supabaseUrl、supabaseAnonKey（在 apps/supabase 下执行 pnpm exec supabase status 查看）
cd apps/web && pnpm dev
```

浏览器访问终端输出的地址（默认 `http://localhost:5173`）。

### 7. 系统设置 · Artifactory

浏览器打开「系统设置」，填写内部/外部 Artifactory Base URL 与 API Key 并保存。

---

## Docker 部署

### 1. 克隆仓库

在部署机上执行（将 URL / 目录名换成你的仓库）：

```bash
git clone https://github.com/<组织>/<仓库>.git
cd <仓库目录名>   # 例如 software_bom_admin
```

后续命令均在该仓库根目录下相对路径说明（如 `deploy/production/...`）。

### 2. 首次拉取：Git 与镜像凭据

**Git**

公开仓库：

```bash
git clone https://github.com/<组织>/<仓库>.git
```

私有仓库（任选一种）：

```bash
git clone https://github.com/<组织>/<仓库>.git
# 提示 Username 时填 GitHub 用户名；提示 Password 时粘贴 PAT（classic 需 repo 读 / fine-grained 需 Contents 读），不是账户登录密码
```

```bash
[ ! -f ~/.ssh/id_ed25519 ] && ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519 -N ""
cat ~/.ssh/id_ed25519.pub
# 将上一条输出的整行粘贴到：GitHub 仓库 → Settings → Deploy keys → Add（只读即可，勿勾 write）
git clone git@github.com:<组织>/<仓库>.git
```

**Docker 镜像（GHCR）**

`deploy.sh` 拉取 `ghcr.io/<GITHUB_REPO>/`*（`GITHUB_REPO` 见 `.deploy.env`）。**包为 Private 时**先在同一用户下登录一次：

```bash
echo '<PAT>' | docker login ghcr.io -u '<GitHub用户名>' --password-stdin
# PAT 勾 read:packages；凭据保存在 ~/.docker/config.json，再执行 ./deploy.sh
```

### 3. 前置

- 已存在 Docker 网络 `supabase_default`（先启动自建 Supabase 栈）。
- 生产库 `system_settings.artifactory_config` 中已配置 Artifactory（或通过 UI 配置）。

### 4. 环境文件

```bash
cp deploy/production/.deploy.env.example deploy/production/.deploy.env
```

按 `deploy/production/.deploy.env.example` 中的注释逐项填写 `.deploy.env` 即可。


复制并编辑前端配置：

```bash
cp deploy/production/app-config.js.example deploy/production/app-config.js
# 按 deploy/production/app-config.js.example 中的注释填写
```

### 5. 部署命令

```bash
cd deploy/production
./deploy.sh <version>
```

示例：`./deploy.sh v1.0.5`（与 `./deploy.sh 1.0.5` 等价，脚本会去掉开头的 `v` 以匹配 GHCR 上无 `v` 的镜像 tag）

首次部署后（或需要重建默认账号）执行一次 seed：

1. 进入 Supabase 管理页面（SQL Editor）。
2. 打开并复制 `deploy/production/scripts/seed.sql` 全部内容。
3. 在 SQL Editor 执行。

web默认账号：`test@example.com` / `test123456`

### 6. 仅更新 compose（不跑 deploy.sh 时）

```bash
cd deploy/production
set -a && source .deploy.env && set +a
VERSION=<version> docker compose up -d
```

或：

```bash
cd deploy/production
docker compose --env-file .deploy.env up -d
```

（`VERSION`、`GITHUB_REPO` 等需已在环境中导出或与 compose 默认值一致；`VERSION` 请用与 GHCR 一致的 tag，一般为无 `v` 的 `1.0.5`，因 compose 不会像 `deploy.sh` 那样自动去 `v`。）