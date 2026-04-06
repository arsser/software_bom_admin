-- ext-Artifactory 查重/Copy/同步等原因单独存放，避免写入 last_fetch_error 触发「本地 pending + 有说明 → local=error」的刷新规则
-- 时间戳须晚于 20260404180000_bom_row_status_jsonb（否则 migration up 会报 “inserted before the last migration”）

ALTER TABLE bom_rows
  ADD COLUMN IF NOT EXISTS ext_fetch_error TEXT;

COMMENT ON COLUMN bom_rows.last_fetch_error IS
  'it-Artifactory 拉取、本地校验/补全 MD5（Storage API）等；不参与 ext 流程';
COMMENT ON COLUMN bom_rows.ext_fetch_error IS
  'ext-Artifactory 查重、Copy、worker 同步等失败说明；不影响 bom_refresh_local_found_statuses_for_batch';
