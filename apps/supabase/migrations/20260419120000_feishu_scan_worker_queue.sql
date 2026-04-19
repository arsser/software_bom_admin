-- 飞书扫描改由 bom-scanner-worker 异步执行：入队字段 + 抢占 / 超时清理 RPC

ALTER TABLE public.bom_feishu_scan_jobs
  ADD COLUMN IF NOT EXISTS auto_create_version_folder boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.bom_feishu_scan_jobs.auto_create_version_folder IS '根下无版本名文件夹时是否自动 create_folder（与 Edge 请求体 autoCreateVersionFolder 一致）';

COMMENT ON TABLE public.bom_feishu_scan_jobs IS '飞书云盘目录扫描任务（入队后由 bom-scanner-worker 执行；Edge 仅负责校验并入队）';


CREATE OR REPLACE FUNCTION public.bom_claim_feishu_scan_job()
RETURNS TABLE(id uuid, batch_id uuid, auto_create_version_folder boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  picked uuid;
BEGIN
  SELECT j2.id
  INTO picked
  FROM public.bom_feishu_scan_jobs j2
  WHERE j2.status = 'queued'::public.bom_feishu_scan_job_status
  ORDER BY j2.requested_at ASC
  LIMIT 1
  FOR UPDATE SKIP LOCKED;

  IF picked IS NULL THEN
    RETURN;
  END IF;

  UPDATE public.bom_feishu_scan_jobs j
  SET status = 'running'::public.bom_feishu_scan_job_status,
      updated_at = now(),
      started_at = coalesce(j.started_at, now())
  WHERE j.id = picked;

  RETURN QUERY
  SELECT j.id, j.batch_id, j.auto_create_version_folder
  FROM public.bom_feishu_scan_jobs j
  WHERE j.id = picked;
END;
$$;

ALTER FUNCTION public.bom_claim_feishu_scan_job() OWNER TO postgres;

COMMENT ON FUNCTION public.bom_claim_feishu_scan_job() IS 'worker 抢占一条排队中的飞书目录扫描任务';


CREATE OR REPLACE FUNCTION public.bom_fail_stale_feishu_scan_jobs(p_stale_seconds integer DEFAULT 7200)
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

  UPDATE public.bom_feishu_scan_jobs j
  SET status = 'failed'::public.bom_feishu_scan_job_status,
      finished_at = now(),
      message = '飞书扫描任务长时间未结束（worker 可能崩溃，请重试）',
      updated_at = now()
  WHERE j.status = 'running'::public.bom_feishu_scan_job_status
    AND coalesce(j.started_at, j.updated_at) < v_cutoff;

  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

ALTER FUNCTION public.bom_fail_stale_feishu_scan_jobs(integer) OWNER TO postgres;

COMMENT ON FUNCTION public.bom_fail_stale_feishu_scan_jobs(integer) IS '将长时间处于 running 的飞书扫描任务标记为 failed，避免永久阻塞';


REVOKE ALL ON FUNCTION public.bom_claim_feishu_scan_job() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.bom_claim_feishu_scan_job() TO anon;
GRANT EXECUTE ON FUNCTION public.bom_claim_feishu_scan_job() TO authenticated;
GRANT EXECUTE ON FUNCTION public.bom_claim_feishu_scan_job() TO service_role;

REVOKE ALL ON FUNCTION public.bom_fail_stale_feishu_scan_jobs(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.bom_fail_stale_feishu_scan_jobs(integer) TO anon;
GRANT EXECUTE ON FUNCTION public.bom_fail_stale_feishu_scan_jobs(integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.bom_fail_stale_feishu_scan_jobs(integer) TO service_role;
