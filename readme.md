# software_bom_admin 调试与部署说明

本文档约定：Artifactory 凭据统一维护在数据库 `system_settings.artifactory_config`，由 worker 与 edge function 在运行时读取。

## 1. 本地调试

### 1.1 启动 Supabase

```bash
cd apps/supabase
pnpm exec supabase start
```

### 1.2 数据库迁移（保留数据）

迁移文件位于 `apps/supabase/migrations/`。升级结构时请**不要**使用 `supabase db reset`：会重建本地数据库并清空**全部数据**（含 `auth` 用户与业务表）。

**本地（`supabase start` 已运行、需应用新迁移且保留现有数据）**

```bash
cd apps/supabase
pnpm exec supabase migration up
```

查看迁移状态：

```bash
pnpm exec supabase migration list
```

**已 link 的远端项目（开发 / 预发 / 生产）**

将本地 migrations 推送到链接的数据库（需先 `supabase link` 并具备权限）：

```bash
cd apps/supabase
pnpm exec supabase db push
```

说明：`db push` 与 `migration up` 均只执行尚未应用的迁移；与 `db reset` 不同，不会主动清空业务数据。

### 1.3 启动 worker

```bash
cd /path/to/software_bom_admin/apps/bom-scanner-worker
npm run start:env
```

### 1.4 启动 edge function

```bash
cd /path/to/software_bom_admin/apps/supabase
pnpm exec supabase functions serve artifactory-api-info --no-verify-jwt
```

本地也可一次拉起多个函数目录（按需增删名称）：

```bash
pnpm exec supabase functions serve artifactory-api-info bom-feishu-scan feishu-auth-test --no-verify-jwt
```

**把本仓库里的函数更新到已 link 的 Supabase 项目（云端 / 托管）**：在项目根或 `apps/supabase` 下执行（需已 `supabase login` 且对本仓库执行过 `supabase link`）：

```bash
cd apps/supabase
# 单个函数
pnpm exec supabase functions deploy feishu-auth-test
pnpm exec supabase functions deploy bom-feishu-scan
# 或部署全部（以 CLI 实际支持为准，常见为不传名则部署 functions 下全部）
pnpm exec supabase functions deploy
```

部署后 Kong 才会路由到对应函数；未部署的函数名在网页里 `invoke` 会得到 **HTTP 404 Function not found**。

**自建 Docker Supabase**（与本仓库 `deploy/production/scripts/sync-edge-functions.sh` 一致）：将 `apps/supabase/functions/` 同步到宿主机 `SUPABASE_DIR/volumes/functions/` 后，在该目录执行 `docker compose up -d functions`（或脚本内已包含的重启步骤）。

### 1.5 在网页设置中配置 Artifactory

打开“系统设置”页面，填写并保存：

- 内部 Artifactory Base URL / API Key
- 外部 Artifactory Base URL / API Key（可选）

说明：

- `bom-scanner-worker` 下载时从数据库读取 `artifactory_config`。
- `artifactory-api-info`：默认合并数据库 `artifactory_config` 与请求体 `previewConfig`（表单预览）后发起 Storage 校验，**不写库**。
- `feishu-auth-test`：`action` 为 `auth`（默认）时换 tenant token；`action: list_drive` 且带 `folderToken` 时列出云盘该目录**第一页**（凭据规则同上）。**修改后须 deploy / 同步**，否则会 404。

## 2. 生产部署

### 2.0 克隆仓库（部署机）

若部署机上还没有本仓库：

```bash
git clone https://github.com/<组织>/<仓库>.git
cd <仓库目录名>   # 例如 software_bom_admin
```

`deploy.sh`、`docker-compose.yml`、`nginx.conf` 等均相对仓库根目录；之后配置里的路径（如 `SUPABASE_DIR`）请使用服务器上的绝对路径。

#### 首次拉取时的认证（Git 与镜像）

**Git**

公开仓库：

```bash
git clone https://github.com/<组织>/<仓库>.git
```

私有仓库任选其一：

```bash
git clone https://github.com/<组织>/<仓库>.git
# Username = GitHub 用户名；Password = PAT（非登录密码；classic 需 repo 读 / fine-grained 需 Contents 读）
```

```bash
[ ! -f ~/.ssh/id_ed25519 ] && ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519 -N ""
cat ~/.ssh/id_ed25519.pub
# 整行粘贴到仓库 Settings → Deploy keys（只读）；再执行：
git clone git@github.com:<组织>/<仓库>.git
```

**镜像（`ghcr.io`）**

`deploy.sh` 会 `docker pull ghcr.io/<GITHUB_REPO>:<版本>`（`GITHUB_REPO` 见 `.deploy.env`）。**GHCR 包为 Private 时**先登录：

```bash
echo '<PAT>' | docker login ghcr.io -u '<GitHub用户名>' --password-stdin
# PAT 需 read:packages；凭据写入 ~/.docker/config.json
```

### 2.1 配置 `deploy/production/.deploy.env`

将示例文件复制为实际环境文件并填写：

```bash
cp deploy/production/.deploy.env.example deploy/production/.deploy.env
```

执行 `./deploy.sh` 时会自动 `source deploy/production/.deploy.env`，其中的变量会传给 `docker compose`。若你**只**手动执行 `docker compose`，需要先载入同一文件，例如：

```bash
cd deploy/production
set -a && source .deploy.env && set +a
docker compose up -d
```

或使用：`docker compose --env-file .deploy.env up -d`（以本机 Docker Compose 版本支持为准）。

#### 镜像与端口（举例）

```env
# 拉取 ghcr.io/<组织>/<仓库>:<VERSION>
GITHUB_REPO=your-org/software_bom_admin

WEB_PORT=80
WEB_SSL_PORT=443
```

#### 数据库与 Supabase 目录（举例）

本地或同机 Docker 内的 Postgres，迁移脚本使用：

```env
DATABASE_URL=postgres://postgres:your_password@supabase-db:5432/postgres?sslmode=disable
```

指向**自建 Supabase** 工程根目录（含 `docker-compose` 与 `volumes/functions` 等）：

```env
SUPABASE_DIR=/home/deploy/supabase-docker
```

Worker 容器需与 Supabase 在同一 Docker 网络（默认外部网络名为 `supabase_default`），通过 Kong 访问 API：

```env
SUPABASE_URL=http://127.0.0.1:8000
SUPABASE_URL_FOR_DOCKER=http://kong:8000
SUPABASE_SERVICE_ROLE_KEY=<与 Supabase 项目一致的 service_role JWT>
```

`SUPABASE_URL` **必填**（`deploy.sh` 会检查）：部署机**宿主机**可访问的 API 根地址，与 Kong 对外映射一致；`docker compose` 不读取此变量。勿填 `http://kong:8000`；`54321` 多为本机 `supabase start`，与典型 Docker 部署不一致。

#### BOM 目录：宿主机路径 → 容器内路径（举例）

`bom-scanner` 服务会把**宿主机上的一个目录**挂载到**容器内的固定路径**，worker 只认环境变量 `BOM_LOCAL_ROOT`（须与 compose 里卷挂载的**容器侧路径**一致）。

当前 `deploy/production/docker-compose.yml` 中的挂载关系为：

```text
${BOM_HOST_STORE}  →  容器内 /bom_store
```

因此**在未修改 compose 的前提下**，`BOM_LOCAL_ROOT` 应始终为 `/bom_store`；你只需要把 `BOM_HOST_STORE` 改成自己机器上希望存放 BOM 的目录。

**举例 1（Linux / macOS）**：宿主机用 `/data2/bom`，映射到容器内 `/bom_store`：

```env
BOM_HOST_STORE=/data2/bom
BOM_LOCAL_ROOT=/bom_store
```

部署前在宿主机创建目录（若不存在）：

```bash
sudo mkdir -p /data2/bom
# 按需调整所有者，使 Docker 有读写权限
```

**举例 2（Windows 宿主机 + Docker Desktop）**：宿主机目录为 `D:\data2\bom`，容器内仍为 `/bom_store`（Linux 容器内使用正斜杠）：

```env
BOM_HOST_STORE=D:/data2/bom
BOM_LOCAL_ROOT=/bom_store
```

也可写 `BOM_HOST_STORE=D:\\data2\\bom`，以本机 Docker 文档为准。

**举例 3（相对路径，便于本机试跑）**：在 `deploy/production` 下执行 compose 时，未设置 `BOM_HOST_STORE` 时默认使用当前目录旁的 `data/host_bom`（与 `docker-compose.yml` 中默认宿主机路径一致）；容器内仍为 `/bom_store`：

```env
BOM_HOST_STORE=./data/host_bom
BOM_LOCAL_ROOT=/bom_store
```

**注意**：若你修改了 `docker-compose.yml` 里卷挂载的**容器侧路径**（例如改为 `:/custom_bom`），则必须把 `BOM_LOCAL_ROOT` 改成相同路径，否则 worker 会读写错误目录。

### 2.2 部署步骤

1. 在生产数据库的 `system_settings.artifactory_config` 写入内部/外部 Base URL 与 API Key。
2. 执行部署：

```bash
cd deploy/production
./deploy.sh <version>
```

`<version>` 与 GHCR 上镜像 tag 一致。CI 对 Git 标签 `v1.0.5` 推送的镜像 tag 多为无 `v` 的 `1.0.5`；你可传 `./deploy.sh v1.0.5` 或 `./deploy.sh 1.0.5`，脚本会自动去掉参数开头的 `v` 再拉镜像。

说明：

- worker 与 edge function 运行时都读取数据库配置，不再要求容器注入 `IT_ARTIFACTORY_*`。
- 建议仅对受信管理员开放 Artifactory 凭据编辑权限。

