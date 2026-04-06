-- cancel_requested：running 任务由用户请求取消时 worker 协作收尾
-- bom_cancel_*：queued 立即 cancelled；running 仅打标 cancel_requested

ALTER TABLE bom_download_jobs
  ADD COLUMN IF NOT EXISTS cancel_requested BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN bom_download_jobs.cancel_requested IS '用户请求取消 running 任务时置 true，worker 检测后置 cancelled 并清零';

ALTER TABLE bom_ext_sync_jobs
  ADD COLUMN IF NOT EXISTS cancel_requested BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN bom_ext_sync_jobs.cancel_requested IS '用户请求取消 running 任务时置 true，worker 检测后置 cancelled 并清零';

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

  UPDATE bom_download_jobs j
  SET cancel_requested = true,
      updated_at = NOW()
  WHERE j.id = p_job_id
    AND j.status = 'running'::bom_download_job_status
    AND EXISTS (
      SELECT 1 FROM bom_batches b
      WHERE b.id = j.batch_id AND b.user_id = v_user
    );

  RETURN FOUND;
END;
$$;

COMMENT ON FUNCTION bom_cancel_download_job(UUID) IS '取消排队中的拉取任务；或对执行中任务请求取消（cancel_requested，由 worker 收尾）';

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

  UPDATE bom_ext_sync_jobs j
  SET cancel_requested = true,
      updated_at = NOW()
  WHERE j.id = p_job_id
    AND j.status = 'running'::bom_download_job_status
    AND EXISTS (
      SELECT 1 FROM bom_batches b
      WHERE b.id = j.batch_id AND b.user_id = v_user
    );

  RETURN FOUND;
END;
$$;

COMMENT ON FUNCTION bom_cancel_ext_sync_job(UUID) IS '取消排队中的 ext 同步；或对执行中任务请求取消（cancel_requested，由 worker 收尾）';
