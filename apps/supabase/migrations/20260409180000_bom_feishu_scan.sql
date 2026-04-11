-- 飞书云盘扫描：任务表 + bom_rows.status 扩展字段（由 Edge 写入，不经 MD5）
-- 上传仍由 worker 实现（本迁移不包含上传任务表）

-- 1) 扫描任务状态枚举
CREATE TYPE public.bom_feishu_scan_job_status AS ENUM (
  'queued',
  'running',
  'succeeded',
  'failed'
);

COMMENT ON TYPE public.bom_feishu_scan_job_status IS '飞书目录扫描任务：queued/running/succeeded/failed';

-- 2) 按 BOM 批次的飞书扫描任务（与 bom_scan_jobs 区分：本表绑定 batch_id）
CREATE TABLE public.bom_feishu_scan_jobs (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  batch_id uuid NOT NULL,
  status public.bom_feishu_scan_job_status DEFAULT 'queued'::public.bom_feishu_scan_job_status NOT NULL,
  trigger_source text DEFAULT 'manual'::text NOT NULL,
  message text,
  rows_total integer DEFAULT 0 NOT NULL,
  rows_present integer DEFAULT 0 NOT NULL,
  rows_absent integer DEFAULT 0 NOT NULL,
  rows_error integer DEFAULT 0 NOT NULL,
  requested_at timestamp with time zone DEFAULT now() NOT NULL,
  started_at timestamp with time zone,
  finished_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT bom_feishu_scan_jobs_pkey PRIMARY KEY (id),
  CONSTRAINT bom_feishu_scan_jobs_batch_id_fkey FOREIGN KEY (batch_id) REFERENCES public.bom_batches(id) ON DELETE CASCADE
);

COMMENT ON TABLE public.bom_feishu_scan_jobs IS '飞书云盘目录扫描任务（Edge Function 同步执行，按版本 batch 维度）';

COMMENT ON COLUMN public.bom_feishu_scan_jobs.rows_total IS '该批次参与扫描的 BOM 行数';
COMMENT ON COLUMN public.bom_feishu_scan_jobs.rows_present IS '在飞书路径下找到对应文件的行数';
COMMENT ON COLUMN public.bom_feishu_scan_jobs.rows_absent IS '未找到对应文件的行数';
COMMENT ON COLUMN public.bom_feishu_scan_jobs.rows_error IS '解析路径或调用飞书 API 出错行数';

CREATE INDEX idx_bom_feishu_scan_jobs_batch ON public.bom_feishu_scan_jobs USING btree (batch_id);

CREATE INDEX idx_bom_feishu_scan_jobs_requested ON public.bom_feishu_scan_jobs USING btree (requested_at DESC);

CREATE INDEX idx_bom_feishu_scan_jobs_status ON public.bom_feishu_scan_jobs USING btree (status);

CREATE TRIGGER update_bom_feishu_scan_jobs_updated_at
  BEFORE UPDATE ON public.bom_feishu_scan_jobs
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.bom_feishu_scan_jobs ENABLE ROW LEVEL SECURITY;

-- 仅允许批次所属用户读写自己的飞书扫描任务；service_role 全量
CREATE POLICY "Users read feishu scan jobs for own batch"
  ON public.bom_feishu_scan_jobs
  FOR SELECT
  USING (
    auth.role() = 'service_role'
    OR EXISTS (
      SELECT 1
      FROM public.bom_batches b
      WHERE b.id = bom_feishu_scan_jobs.batch_id
        AND b.user_id = auth.uid()
    )
  );

CREATE POLICY "Users insert feishu scan jobs for own batch"
  ON public.bom_feishu_scan_jobs
  FOR INSERT
  WITH CHECK (
    auth.role() = 'service_role'
    OR EXISTS (
      SELECT 1
      FROM public.bom_batches b
      WHERE b.id = bom_feishu_scan_jobs.batch_id
        AND b.user_id = auth.uid()
    )
  );

CREATE POLICY "Users update feishu scan jobs for own batch"
  ON public.bom_feishu_scan_jobs
  FOR UPDATE
  USING (
    auth.role() = 'service_role'
    OR EXISTS (
      SELECT 1
      FROM public.bom_batches b
      WHERE b.id = bom_feishu_scan_jobs.batch_id
        AND b.user_id = auth.uid()
    )
  )
  WITH CHECK (
    auth.role() = 'service_role'
    OR EXISTS (
      SELECT 1
      FROM public.bom_batches b
      WHERE b.id = bom_feishu_scan_jobs.batch_id
        AND b.user_id = auth.uid()
    )
  );

CREATE POLICY "Service role full bom_feishu_scan_jobs"
  ON public.bom_feishu_scan_jobs
  TO service_role
  USING (true)
  WITH CHECK (true);

GRANT ALL ON TABLE public.bom_feishu_scan_jobs TO anon;
GRANT ALL ON TABLE public.bom_feishu_scan_jobs TO authenticated;
GRANT ALL ON TABLE public.bom_feishu_scan_jobs TO service_role;

-- 3) bom_rows.status：补充说明（可选键 feishu / feishu_* 由应用写入，CHECK 不限制附加键）
COMMENT ON COLUMN public.bom_rows.status IS 'JSONB：local、ext 为必填枚举；可选 local_fetch_error、ext_fetch_error。飞书扫描可选写入 feishu（not_scanned|absent|present|error）、feishu_file_token、feishu_revision、feishu_file_name、feishu_size_bytes、feishu_scan_error、feishu_scanned_at。';
