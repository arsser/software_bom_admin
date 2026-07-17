-- 飞书 package-manifest 扫描刷新任务（产品维度）

DO $$ BEGIN
  CREATE TYPE public.bom_feishu_manifest_job_status AS ENUM (
    'queued',
    'running',
    'succeeded',
    'failed'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS public.bom_feishu_manifest_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status public.bom_feishu_manifest_job_status NOT NULL DEFAULT 'queued',
  trigger_source text,
  message text,
  files_total integer NOT NULL DEFAULT 0,
  files_with_md5 integer NOT NULL DEFAULT 0,
  files_without_md5 integer NOT NULL DEFAULT 0,
  requested_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  heartbeat_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.bom_feishu_manifest_jobs IS '飞书 package-manifest.json 扫描刷新任务（产品维度，由 bom-scanner-worker 执行）';
COMMENT ON COLUMN public.bom_feishu_manifest_jobs.files_total IS '扫描到的软件包文件数（不含 meta）';
COMMENT ON COLUMN public.bom_feishu_manifest_jobs.files_with_md5 IS '成功关联到 MD5 的条目数';
COMMENT ON COLUMN public.bom_feishu_manifest_jobs.files_without_md5 IS '未能关联 MD5 的条目数';

CREATE INDEX IF NOT EXISTS idx_bom_feishu_manifest_jobs_product
  ON public.bom_feishu_manifest_jobs (product_id);
CREATE INDEX IF NOT EXISTS idx_bom_feishu_manifest_jobs_status
  ON public.bom_feishu_manifest_jobs (status);
CREATE INDEX IF NOT EXISTS idx_bom_feishu_manifest_jobs_requested
  ON public.bom_feishu_manifest_jobs (requested_at DESC);

DROP TRIGGER IF EXISTS update_bom_feishu_manifest_jobs_updated_at ON public.bom_feishu_manifest_jobs;
CREATE TRIGGER update_bom_feishu_manifest_jobs_updated_at
  BEFORE UPDATE ON public.bom_feishu_manifest_jobs
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.bom_feishu_manifest_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full bom_feishu_manifest_jobs" ON public.bom_feishu_manifest_jobs;
CREATE POLICY "Service role full bom_feishu_manifest_jobs"
  ON public.bom_feishu_manifest_jobs
  TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "Users read own feishu manifest jobs" ON public.bom_feishu_manifest_jobs;
CREATE POLICY "Users read own feishu manifest jobs"
  ON public.bom_feishu_manifest_jobs
  FOR SELECT
  USING (
    auth.role() = 'service_role'
    OR EXISTS (
      SELECT 1 FROM public.products p
      WHERE p.id = bom_feishu_manifest_jobs.product_id
        AND p.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Users insert own feishu manifest jobs" ON public.bom_feishu_manifest_jobs;
CREATE POLICY "Users insert own feishu manifest jobs"
  ON public.bom_feishu_manifest_jobs
  FOR INSERT
  WITH CHECK (
    auth.role() = 'service_role'
    OR (
      user_id = auth.uid()
      AND EXISTS (
        SELECT 1 FROM public.products p
        WHERE p.id = product_id AND p.user_id = auth.uid()
      )
    )
  );

DROP POLICY IF EXISTS "Users update own feishu manifest jobs" ON public.bom_feishu_manifest_jobs;
CREATE POLICY "Users update own feishu manifest jobs"
  ON public.bom_feishu_manifest_jobs
  FOR UPDATE
  USING (
    auth.role() = 'service_role'
    OR EXISTS (
      SELECT 1 FROM public.products p
      WHERE p.id = bom_feishu_manifest_jobs.product_id
        AND p.user_id = auth.uid()
    )
  )
  WITH CHECK (
    auth.role() = 'service_role'
    OR EXISTS (
      SELECT 1 FROM public.products p
      WHERE p.id = bom_feishu_manifest_jobs.product_id
        AND p.user_id = auth.uid()
    )
  );

GRANT ALL ON TABLE public.bom_feishu_manifest_jobs TO anon;
GRANT ALL ON TABLE public.bom_feishu_manifest_jobs TO authenticated;
GRANT ALL ON TABLE public.bom_feishu_manifest_jobs TO service_role;

CREATE OR REPLACE FUNCTION public.bom_claim_feishu_manifest_job()
RETURNS TABLE(id uuid, product_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  picked uuid;
BEGIN
  SELECT j2.id
  INTO picked
  FROM public.bom_feishu_manifest_jobs j2
  WHERE j2.status = 'queued'::public.bom_feishu_manifest_job_status
  ORDER BY j2.requested_at ASC
  LIMIT 1
  FOR UPDATE SKIP LOCKED;

  IF picked IS NULL THEN
    RETURN;
  END IF;

  UPDATE public.bom_feishu_manifest_jobs j
  SET status = 'running'::public.bom_feishu_manifest_job_status,
      updated_at = now(),
      started_at = coalesce(j.started_at, now()),
      heartbeat_at = now()
  WHERE j.id = picked;

  RETURN QUERY
  SELECT j.id, j.product_id
  FROM public.bom_feishu_manifest_jobs j
  WHERE j.id = picked;
END;
$$;

ALTER FUNCTION public.bom_claim_feishu_manifest_job() OWNER TO postgres;
COMMENT ON FUNCTION public.bom_claim_feishu_manifest_job() IS 'worker 抢占一条排队中的飞书 manifest 扫描刷新任务';

CREATE OR REPLACE FUNCTION public.bom_fail_stale_feishu_manifest_jobs(p_stale_seconds integer DEFAULT 7200)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  n integer := 0;
  v_cutoff timestamptz;
BEGIN
  IF p_stale_seconds IS NULL OR p_stale_seconds < 300 THEN
    p_stale_seconds := 7200;
  END IF;
  v_cutoff := now() - (p_stale_seconds::text || ' seconds')::interval;

  UPDATE public.bom_feishu_manifest_jobs j
  SET status = 'failed'::public.bom_feishu_manifest_job_status,
      finished_at = now(),
      message = '飞书清单扫描任务长时间未结束（worker 可能崩溃，请重试）',
      updated_at = now()
  WHERE j.status = 'running'::public.bom_feishu_manifest_job_status
    AND coalesce(j.heartbeat_at, j.started_at, j.updated_at) < v_cutoff;

  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

ALTER FUNCTION public.bom_fail_stale_feishu_manifest_jobs(integer) OWNER TO postgres;
COMMENT ON FUNCTION public.bom_fail_stale_feishu_manifest_jobs(integer) IS '将长时间处于 running 的飞书清单扫描任务标记为 failed';

REVOKE ALL ON FUNCTION public.bom_claim_feishu_manifest_job() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.bom_claim_feishu_manifest_job() TO anon;
GRANT EXECUTE ON FUNCTION public.bom_claim_feishu_manifest_job() TO authenticated;
GRANT EXECUTE ON FUNCTION public.bom_claim_feishu_manifest_job() TO service_role;

REVOKE ALL ON FUNCTION public.bom_fail_stale_feishu_manifest_jobs(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.bom_fail_stale_feishu_manifest_jobs(integer) TO anon;
GRANT EXECUTE ON FUNCTION public.bom_fail_stale_feishu_manifest_jobs(integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.bom_fail_stale_feishu_manifest_jobs(integer) TO service_role;
