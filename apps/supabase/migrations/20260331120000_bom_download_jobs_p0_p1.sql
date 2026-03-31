-- P0/P1：下载任务心跳、僵尸回收、字节进度字段；claim 时写入 started_at/heartbeat_at

ALTER TABLE bom_download_jobs
  ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS running_row_id UUID REFERENCES bom_rows(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS running_file_name TEXT,
  ADD COLUMN IF NOT EXISTS running_bytes_downloaded BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS running_bytes_total BIGINT,
  ADD COLUMN IF NOT EXISTS bytes_downloaded_total BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS bytes_total BIGINT;

COMMENT ON COLUMN bom_download_jobs.started_at IS 'worker 首次抢占为 running 的时间';
COMMENT ON COLUMN bom_download_jobs.heartbeat_at IS 'worker 心跳，用于僵尸任务回收';
COMMENT ON COLUMN bom_download_jobs.running_row_id IS '当前正在下载的 BOM 行';
COMMENT ON COLUMN bom_download_jobs.running_file_name IS '当前下载目标文件名（展示）';
COMMENT ON COLUMN bom_download_jobs.running_bytes_downloaded IS '当前文件已下载字节';
COMMENT ON COLUMN bom_download_jobs.running_bytes_total IS '当前文件总字节（Content-Length 等，可为空）';
COMMENT ON COLUMN bom_download_jobs.bytes_downloaded_total IS '本任务已完成的文件字节累计';
COMMENT ON COLUMN bom_download_jobs.bytes_total IS '本任务预估总字节（能汇总时写入，可为空）';

-- 抢占时写入开始时间与心跳
CREATE OR REPLACE FUNCTION bom_claim_download_job()
RETURNS TABLE(
  id UUID,
  batch_id UUID,
  row_ids UUID[],
  progress_total INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  picked UUID;
BEGIN
  SELECT j2.id
  INTO picked
  FROM bom_download_jobs j2
  WHERE j2.status = 'queued'::bom_download_job_status
  ORDER BY j2.created_at ASC
  LIMIT 1
  FOR UPDATE SKIP LOCKED;

  IF picked IS NULL THEN
    RETURN;
  END IF;

  UPDATE bom_download_jobs j
  SET status = 'running'::bom_download_job_status,
      updated_at = NOW(),
      started_at = COALESCE(j.started_at, NOW()),
      heartbeat_at = NOW()
  WHERE j.id = picked;

  RETURN QUERY
  SELECT j.id, j.batch_id, j.row_ids, j.progress_total
  FROM bom_download_jobs j
  WHERE j.id = picked;
END;
$$;

COMMENT ON FUNCTION bom_claim_download_job() IS 'worker 抢占一条排队中的拉取任务（service_role）；写入 started_at/heartbeat_at';

-- 将长时间无心跳的 running 任务标记为失败（worker 定期调用）
CREATE OR REPLACE FUNCTION bom_fail_stale_download_jobs(p_stale_seconds INTEGER DEFAULT 900)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  n INTEGER := 0;
  v_cutoff TIMESTAMPTZ;
BEGIN
  IF p_stale_seconds IS NULL OR p_stale_seconds < 60 THEN
    p_stale_seconds := 900;
  END IF;
  v_cutoff := NOW() - (p_stale_seconds::text || ' seconds')::interval;

  UPDATE bom_download_jobs j
  SET status = 'failed'::bom_download_job_status,
      finished_at = NOW(),
      last_message = 'worker 心跳超时（可能进程崩溃或网络中断）',
      updated_at = NOW(),
      running_row_id = NULL,
      running_file_name = NULL
  WHERE j.status = 'running'::bom_download_job_status
    AND COALESCE(j.heartbeat_at, j.updated_at, j.started_at) < v_cutoff;

  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

REVOKE ALL ON FUNCTION bom_fail_stale_download_jobs(INTEGER) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION bom_fail_stale_download_jobs(INTEGER) FROM authenticated;
GRANT EXECUTE ON FUNCTION bom_fail_stale_download_jobs(INTEGER) TO service_role;

COMMENT ON FUNCTION bom_fail_stale_download_jobs(INTEGER) IS '将 running 且心跳过期的下载任务标记为 failed（service_role）';
