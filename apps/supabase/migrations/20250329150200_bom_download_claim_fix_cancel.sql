-- 修复抢占语义；支持用户取消「排队中」的拉取任务

-- 使用同一事务内先 FOR UPDATE 锁定再 UPDATE，避免子查询内 FOR UPDATE 与外层 UPDATE 行为不一致
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
      updated_at = NOW()
  WHERE j.id = picked;

  RETURN QUERY
  SELECT j.id, j.batch_id, j.row_ids, j.progress_total
  FROM bom_download_jobs j
  WHERE j.id = picked;
END;
$$;

COMMENT ON FUNCTION bom_claim_download_job() IS 'worker 抢占一条排队中的拉取任务（service_role）';

-- 仅允许取消「排队中」且属主批次匹配的任务
CREATE OR REPLACE FUNCTION bom_cancel_download_job(p_job_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user UUID := auth.uid();
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  UPDATE bom_download_jobs j
  SET status = 'cancelled'::bom_download_job_status,
      finished_at = NOW(),
      last_message = '用户取消排队',
      updated_at = NOW()
  WHERE j.id = p_job_id
    AND j.status = 'queued'::bom_download_job_status
    AND EXISTS (
      SELECT 1 FROM bom_batches b
      WHERE b.id = j.batch_id AND b.user_id = v_user
    );

  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION bom_cancel_download_job(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION bom_cancel_download_job(UUID) TO authenticated;

COMMENT ON FUNCTION bom_cancel_download_job(UUID) IS '取消排队中的网页拉取任务（已开始执行则无法取消）';
