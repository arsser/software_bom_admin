-- 将长时间停留在 running 的本地扫描任务标记为 failed，避免阻塞调度器与 prune

CREATE OR REPLACE FUNCTION bom_fail_stale_scan_jobs(p_stale_seconds INTEGER DEFAULT 7200)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  n INTEGER := 0;
  v_cutoff TIMESTAMPTZ;
BEGIN
  IF p_stale_seconds IS NULL OR p_stale_seconds < 300 THEN
    p_stale_seconds := 7200;
  END IF;
  v_cutoff := NOW() - (p_stale_seconds::text || ' seconds')::interval;

  UPDATE bom_scan_jobs j
  SET status = 'failed'::bom_scan_job_status,
      finished_at = NOW(),
      message = '扫描任务超时未结束（worker 可能崩溃或进程被中断）；未执行 bom_finalize_scan，local_file 未 prune。下次成功扫描后会收敛。',
      updated_at = NOW()
  WHERE j.status = 'running'::bom_scan_job_status
    AND j.started_at IS NOT NULL
    AND j.started_at < v_cutoff;

  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

REVOKE ALL ON FUNCTION bom_fail_stale_scan_jobs(INTEGER) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION bom_fail_stale_scan_jobs(INTEGER) FROM authenticated;
GRANT EXECUTE ON FUNCTION bom_fail_stale_scan_jobs(INTEGER) TO service_role;

COMMENT ON FUNCTION bom_fail_stale_scan_jobs(INTEGER) IS '将 running 且 started_at 过久未结束的扫描任务标记为 failed（service_role），解除调度阻塞';
