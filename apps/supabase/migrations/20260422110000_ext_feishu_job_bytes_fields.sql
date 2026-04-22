-- 为外部 Artifactory 同步 / 飞书上传任务补充字节进度字段，便于与内部拉取页面结构对齐。

ALTER TABLE public.bom_ext_sync_jobs
  ADD COLUMN IF NOT EXISTS running_bytes_downloaded bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS running_bytes_total bigint,
  ADD COLUMN IF NOT EXISTS bytes_downloaded_total bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS bytes_total bigint;

ALTER TABLE public.bom_feishu_upload_jobs
  ADD COLUMN IF NOT EXISTS running_bytes_downloaded bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS running_bytes_total bigint,
  ADD COLUMN IF NOT EXISTS bytes_downloaded_total bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS bytes_total bigint;

COMMENT ON COLUMN public.bom_ext_sync_jobs.running_bytes_downloaded IS '当前行已处理字节';
COMMENT ON COLUMN public.bom_ext_sync_jobs.running_bytes_total IS '当前行总字节（可为空）';
COMMENT ON COLUMN public.bom_ext_sync_jobs.bytes_downloaded_total IS '任务累计已处理字节';
COMMENT ON COLUMN public.bom_ext_sync_jobs.bytes_total IS '任务预估总字节（可为空）';

COMMENT ON COLUMN public.bom_feishu_upload_jobs.running_bytes_downloaded IS '当前文件已上传字节';
COMMENT ON COLUMN public.bom_feishu_upload_jobs.running_bytes_total IS '当前文件总字节（可为空）';
COMMENT ON COLUMN public.bom_feishu_upload_jobs.bytes_downloaded_total IS '任务累计已上传字节';
COMMENT ON COLUMN public.bom_feishu_upload_jobs.bytes_total IS '任务预估总字节（可为空）';
