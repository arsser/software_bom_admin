-- 取消 RPC：
--   queued → 立即 cancelled
--   running 且 cancel_requested=false → 首次打标，worker 协作中断
--   running 且 cancel_requested=true → worker 未响应，强制 cancelled
--   failed → 关闭为 cancelled
--   succeeded/cancelled → 幂等 true

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

  -- queued → cancelled
  UPDATE bom_download_jobs j
  SET status = 'cancelled'::bom_download_job_status,
      finished_at = NOW(),
      last_message = '用户取消排队',
      updated_at = NOW(),
      cancel_requested = false,
      running_row_id = NULL
  WHERE j.id = p_job_id
    AND j.status = 'queued'::bom_download_job_status
    AND EXISTS (
      SELECT 1 FROM bom_batches b
      WHERE b.id = j.batch_id AND b.user_id = v_user
    );

  IF FOUND THEN
    RETURN TRUE;
  END IF;

  -- running + cancel_requested already true → worker 未响应，强制 cancelled
  UPDATE bom_download_jobs j
  SET status = 'cancelled'::bom_download_job_status,
      finished_at = NOW(),
      last_message = COALESCE(j.last_message, '') || '（用户强制取消）',
      updated_at = NOW(),
      cancel_requested = false,
      running_row_id = NULL,
      running_file_name = NULL,
      running_bytes_downloaded = 0,
      running_bytes_total = NULL
  WHERE j.id = p_job_id
    AND j.status = 'running'::bom_download_job_status
    AND j.cancel_requested = true
    AND EXISTS (
      SELECT 1 FROM bom_batches b
      WHERE b.id = j.batch_id AND b.user_id = v_user
    );

  IF FOUND THEN
    RETURN TRUE;
  END IF;

  -- running + cancel_requested=false → 首次请求取消
  UPDATE bom_download_jobs j
  SET cancel_requested = true,
      updated_at = NOW()
  WHERE j.id = p_job_id
    AND j.status = 'running'::bom_download_job_status
    AND j.cancel_requested = false
    AND EXISTS (
      SELECT 1 FROM bom_batches b
      WHERE b.id = j.batch_id AND b.user_id = v_user
    );

  IF FOUND THEN
    RETURN TRUE;
  END IF;

  -- failed → cancelled
  UPDATE bom_download_jobs j
  SET status = 'cancelled'::bom_download_job_status,
      updated_at = NOW(),
      cancel_requested = false,
      running_row_id = NULL,
      running_file_name = NULL,
      running_bytes_downloaded = 0,
      running_bytes_total = NULL
  WHERE j.id = p_job_id
    AND j.status = 'failed'::bom_download_job_status
    AND EXISTS (
      SELECT 1 FROM bom_batches b
      WHERE b.id = j.batch_id AND b.user_id = v_user
    );

  IF FOUND THEN
    RETURN TRUE;
  END IF;

  -- succeeded / cancelled → 幂等 true
  RETURN EXISTS (
    SELECT 1
    FROM bom_download_jobs j
    WHERE j.id = p_job_id
      AND j.status IN ('succeeded'::bom_download_job_status, 'cancelled'::bom_download_job_status)
      AND EXISTS (
        SELECT 1 FROM bom_batches b
        WHERE b.id = j.batch_id AND b.user_id = v_user
      )
  );
END;
$$;

COMMENT ON FUNCTION bom_cancel_download_job(UUID) IS
  '取消排队；running 首次打标 cancel_requested，二次强制 cancelled；failed 关闭为 cancelled；succeeded/cancelled 幂等';

CREATE OR REPLACE FUNCTION bom_cancel_ext_sync_job(p_job_id UUID)
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

  -- queued → cancelled
  UPDATE bom_ext_sync_jobs j
  SET status = 'cancelled'::bom_download_job_status,
      finished_at = NOW(),
      last_message = '用户取消排队',
      updated_at = NOW(),
      cancel_requested = false,
      running_row_id = NULL
  WHERE j.id = p_job_id
    AND j.status = 'queued'::bom_download_job_status
    AND EXISTS (
      SELECT 1 FROM bom_batches b
      WHERE b.id = j.batch_id AND b.user_id = v_user
    );

  IF FOUND THEN
    RETURN TRUE;
  END IF;

  -- running + cancel_requested already true → 强制 cancelled
  UPDATE bom_ext_sync_jobs j
  SET status = 'cancelled'::bom_download_job_status,
      finished_at = NOW(),
      last_message = COALESCE(j.last_message, '') || '（用户强制取消）',
      updated_at = NOW(),
      cancel_requested = false,
      running_row_id = NULL
  WHERE j.id = p_job_id
    AND j.status = 'running'::bom_download_job_status
    AND j.cancel_requested = true
    AND EXISTS (
      SELECT 1 FROM bom_batches b
      WHERE b.id = j.batch_id AND b.user_id = v_user
    );

  IF FOUND THEN
    RETURN TRUE;
  END IF;

  -- running + cancel_requested=false → 首次请求取消
  UPDATE bom_ext_sync_jobs j
  SET cancel_requested = true,
      updated_at = NOW()
  WHERE j.id = p_job_id
    AND j.status = 'running'::bom_download_job_status
    AND j.cancel_requested = false
    AND EXISTS (
      SELECT 1 FROM bom_batches b
      WHERE b.id = j.batch_id AND b.user_id = v_user
    );

  IF FOUND THEN
    RETURN TRUE;
  END IF;

  -- failed → cancelled
  UPDATE bom_ext_sync_jobs j
  SET status = 'cancelled'::bom_download_job_status,
      updated_at = NOW(),
      cancel_requested = false,
      running_row_id = NULL
  WHERE j.id = p_job_id
    AND j.status = 'failed'::bom_download_job_status
    AND EXISTS (
      SELECT 1 FROM bom_batches b
      WHERE b.id = j.batch_id AND b.user_id = v_user
    );

  IF FOUND THEN
    RETURN TRUE;
  END IF;

  -- succeeded / cancelled → 幂等 true
  RETURN EXISTS (
    SELECT 1
    FROM bom_ext_sync_jobs j
    WHERE j.id = p_job_id
      AND j.status IN ('succeeded'::bom_download_job_status, 'cancelled'::bom_download_job_status)
      AND EXISTS (
        SELECT 1 FROM bom_batches b
        WHERE b.id = j.batch_id AND b.user_id = v_user
      )
  );
END;
$$;

COMMENT ON FUNCTION bom_cancel_ext_sync_job(UUID) IS
  '取消排队；running 首次打标 cancel_requested，二次强制 cancelled；failed 关闭为 cancelled；succeeded/cancelled 幂等';
