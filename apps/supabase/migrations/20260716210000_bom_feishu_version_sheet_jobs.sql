-- 飞书版本目录「软件包清单」电子表格生成任务（批次维度，手动重生成）

DO $$ BEGIN
  CREATE TYPE public.bom_feishu_version_sheet_job_status AS ENUM (
    'queued',
    'running',
    'succeeded',
    'failed'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS public.bom_feishu_version_sheet_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES public.bom_batches(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status public.bom_feishu_version_sheet_job_status NOT NULL DEFAULT 'queued',
  trigger_source text,
  message text,
  sheet_url text,
  row_count integer NOT NULL DEFAULT 0,
  requested_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  heartbeat_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.bom_feishu_version_sheet_jobs IS '版本目录飞书「软件包清单」表格生成任务（上传结束自动生成；亦可手动入队）';

CREATE INDEX IF NOT EXISTS idx_bom_feishu_version_sheet_jobs_batch
  ON public.bom_feishu_version_sheet_jobs (batch_id);
CREATE INDEX IF NOT EXISTS idx_bom_feishu_version_sheet_jobs_status
  ON public.bom_feishu_version_sheet_jobs (status);
CREATE INDEX IF NOT EXISTS idx_bom_feishu_version_sheet_jobs_requested
  ON public.bom_feishu_version_sheet_jobs (requested_at DESC);

DROP TRIGGER IF EXISTS update_bom_feishu_version_sheet_jobs_updated_at ON public.bom_feishu_version_sheet_jobs;
CREATE TRIGGER update_bom_feishu_version_sheet_jobs_updated_at
  BEFORE UPDATE ON public.bom_feishu_version_sheet_jobs
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.bom_feishu_version_sheet_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full bom_feishu_version_sheet_jobs" ON public.bom_feishu_version_sheet_jobs;
CREATE POLICY "Service role full bom_feishu_version_sheet_jobs"
  ON public.bom_feishu_version_sheet_jobs
  TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "Users read own feishu version sheet jobs" ON public.bom_feishu_version_sheet_jobs;
CREATE POLICY "Users read own feishu version sheet jobs"
  ON public.bom_feishu_version_sheet_jobs
  FOR SELECT
  USING (
    auth.role() = 'service_role'
    OR EXISTS (
      SELECT 1 FROM public.bom_batches b
      WHERE b.id = bom_feishu_version_sheet_jobs.batch_id
        AND b.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Users insert own feishu version sheet jobs" ON public.bom_feishu_version_sheet_jobs;
CREATE POLICY "Users insert own feishu version sheet jobs"
  ON public.bom_feishu_version_sheet_jobs
  FOR INSERT
  WITH CHECK (
    auth.role() = 'service_role'
    OR (
      user_id = auth.uid()
      AND EXISTS (
        SELECT 1 FROM public.bom_batches b
        WHERE b.id = batch_id AND b.user_id = auth.uid()
      )
    )
  );

DROP POLICY IF EXISTS "Users update own feishu version sheet jobs" ON public.bom_feishu_version_sheet_jobs;
CREATE POLICY "Users update own feishu version sheet jobs"
  ON public.bom_feishu_version_sheet_jobs
  FOR UPDATE
  USING (
    auth.role() = 'service_role'
    OR EXISTS (
      SELECT 1 FROM public.bom_batches b
      WHERE b.id = bom_feishu_version_sheet_jobs.batch_id
        AND b.user_id = auth.uid()
    )
  )
  WITH CHECK (
    auth.role() = 'service_role'
    OR EXISTS (
      SELECT 1 FROM public.bom_batches b
      WHERE b.id = bom_feishu_version_sheet_jobs.batch_id
        AND b.user_id = auth.uid()
    )
  );

GRANT ALL ON TABLE public.bom_feishu_version_sheet_jobs TO anon;
GRANT ALL ON TABLE public.bom_feishu_version_sheet_jobs TO authenticated;
GRANT ALL ON TABLE public.bom_feishu_version_sheet_jobs TO service_role;

CREATE OR REPLACE FUNCTION public.bom_claim_feishu_version_sheet_job()
RETURNS TABLE(id uuid, batch_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  picked uuid;
BEGIN
  SELECT j2.id
  INTO picked
  FROM public.bom_feishu_version_sheet_jobs j2
  WHERE j2.status = 'queued'::public.bom_feishu_version_sheet_job_status
  ORDER BY j2.requested_at ASC
  LIMIT 1
  FOR UPDATE SKIP LOCKED;

  IF picked IS NULL THEN
    RETURN;
  END IF;

  UPDATE public.bom_feishu_version_sheet_jobs j
  SET status = 'running'::public.bom_feishu_version_sheet_job_status,
      updated_at = now(),
      started_at = coalesce(j.started_at, now()),
      heartbeat_at = now()
  WHERE j.id = picked;

  RETURN QUERY
  SELECT j.id, j.batch_id
  FROM public.bom_feishu_version_sheet_jobs j
  WHERE j.id = picked;
END;
$$;

ALTER FUNCTION public.bom_claim_feishu_version_sheet_job() OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.bom_fail_stale_feishu_version_sheet_jobs(p_stale_seconds integer DEFAULT 3600)
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
    p_stale_seconds := 3600;
  END IF;
  v_cutoff := now() - (p_stale_seconds::text || ' seconds')::interval;

  UPDATE public.bom_feishu_version_sheet_jobs j
  SET status = 'failed'::public.bom_feishu_version_sheet_job_status,
      finished_at = now(),
      message = '版本清单表格任务长时间未结束（worker 可能崩溃，请重试）',
      updated_at = now()
  WHERE j.status = 'running'::public.bom_feishu_version_sheet_job_status
    AND coalesce(j.heartbeat_at, j.started_at, j.updated_at) < v_cutoff;

  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

ALTER FUNCTION public.bom_fail_stale_feishu_version_sheet_jobs(integer) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.bom_claim_feishu_version_sheet_job() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.bom_claim_feishu_version_sheet_job() TO anon;
GRANT EXECUTE ON FUNCTION public.bom_claim_feishu_version_sheet_job() TO authenticated;
GRANT EXECUTE ON FUNCTION public.bom_claim_feishu_version_sheet_job() TO service_role;

REVOKE ALL ON FUNCTION public.bom_fail_stale_feishu_version_sheet_jobs(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.bom_fail_stale_feishu_version_sheet_jobs(integer) TO anon;
GRANT EXECUTE ON FUNCTION public.bom_fail_stale_feishu_version_sheet_jobs(integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.bom_fail_stale_feishu_version_sheet_jobs(integer) TO service_role;
