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

### 1.5 在网页设置中配置 Artifactory

打开“系统设置”页面，填写并保存：

- 主实例 Base URL / API Key
- 扩展实例 Base URL / API Key（可选）

说明：

- `bom-scanner-worker` 下载时从数据库读取 `artifactory_config`。
- `artifactory-api-info` edge function 查询时也从数据库读取 `artifactory_config`。
- 硬约束：edge 不接受请求体中的 `apiKey/config` 覆盖（会返回 400）。

## 2. 生产部署

1. 在生产数据库的 `system_settings.artifactory_config` 写入主/扩展 Base URL 与 API Key。
2. 执行部署：

```bash
cd deploy/production
./deploy.sh <version>
```

说明：

- worker 与 edge function 运行时都读取数据库配置，不再要求容器注入 `IT_ARTIFACTORY_*`。
- 建议仅对受信管理员开放 Artifactory 凭据编辑权限。

