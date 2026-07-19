-- 上传结束后自动入队「软件包清单」；分批上传时对 running 任务打 needs_rerun，跑完再排一次

ALTER TABLE public.bom_feishu_version_sheet_jobs
  ADD COLUMN IF NOT EXISTS needs_rerun boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.bom_feishu_version_sheet_jobs.needs_rerun IS
  '上传等触发时若本批已有 running 清单任务，则置 true；任务结束后再入队一次以纳入新 present 行';

CREATE OR REPLACE FUNCTION public.bom_enqueue_feishu_version_sheet(
  p_batch_id uuid,
  p_trigger_source text DEFAULT 'upload'
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  v_owner uuid;
  v_job uuid;
  v_status public.bom_feishu_version_sheet_job_status;
  v_src text := NULLIF(BTRIM(COALESCE(p_trigger_source, '')), '');
BEGIN
  IF p_batch_id IS NULL THEN
    RAISE EXCEPTION 'batch_id required';
  END IF;

  SELECT b.user_id INTO v_owner
  FROM public.bom_batches b
  WHERE b.id = p_batch_id;
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'batch not found';
  END IF;

  -- 已有排队：等它执行时会读到最新 present，无需再插
  SELECT j.id, j.status
  INTO v_job, v_status
  FROM public.bom_feishu_version_sheet_jobs j
  WHERE j.batch_id = p_batch_id
    AND j.status = 'queued'::public.bom_feishu_version_sheet_job_status
  ORDER BY j.requested_at ASC
  LIMIT 1
  FOR UPDATE SKIP LOCKED;

  IF v_job IS NOT NULL THEN
    RETURN v_job;
  END IF;

  -- 正在跑：标记跑完再生成，避免分批上传漏行
  SELECT j.id
  INTO v_job
  FROM public.bom_feishu_version_sheet_jobs j
  WHERE j.batch_id = p_batch_id
    AND j.status = 'running'::public.bom_feishu_version_sheet_job_status
  ORDER BY j.requested_at DESC
  LIMIT 1
  FOR UPDATE SKIP LOCKED;

  IF v_job IS NOT NULL THEN
    UPDATE public.bom_feishu_version_sheet_jobs
    SET needs_rerun = true,
        updated_at = now()
    WHERE id = v_job;
    RETURN v_job;
  END IF;

  INSERT INTO public.bom_feishu_version_sheet_jobs (
    batch_id, user_id, status, trigger_source, message, needs_rerun
  )
  VALUES (
    p_batch_id,
    v_owner,
    'queued'::public.bom_feishu_version_sheet_job_status,
    COALESCE(v_src, 'upload'),
    NULL,
    false
  )
  RETURNING id INTO v_job;

  RETURN v_job;
END;
$$;

COMMENT ON FUNCTION public.bom_enqueue_feishu_version_sheet(uuid, text) IS
  '入队版本目录软件包清单生成：queued 复用；running 则 needs_rerun；否则新建';

CREATE OR REPLACE FUNCTION public.bom_finish_feishu_version_sheet_rerun_if_needed(p_job_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  v_batch uuid;
  v_need boolean;
  v_next uuid;
BEGIN
  IF p_job_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT j.batch_id, j.needs_rerun
  INTO v_batch, v_need
  FROM public.bom_feishu_version_sheet_jobs j
  WHERE j.id = p_job_id
  FOR UPDATE;

  IF v_batch IS NULL THEN
    RETURN NULL;
  END IF;

  UPDATE public.bom_feishu_version_sheet_jobs
  SET needs_rerun = false,
      updated_at = now()
  WHERE id = p_job_id;

  IF NOT COALESCE(v_need) THEN
    RETURN NULL;
  END IF;

  v_next := public.bom_enqueue_feishu_version_sheet(v_batch, 'rerun_after_upload');
  RETURN v_next;
END;
$$;

COMMENT ON FUNCTION public.bom_finish_feishu_version_sheet_rerun_if_needed(uuid) IS
  '清单任务结束后若 needs_rerun 则再入队一次';

REVOKE ALL ON FUNCTION public.bom_enqueue_feishu_version_sheet(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.bom_enqueue_feishu_version_sheet(uuid, text) TO anon;
GRANT EXECUTE ON FUNCTION public.bom_enqueue_feishu_version_sheet(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.bom_enqueue_feishu_version_sheet(uuid, text) TO service_role;

REVOKE ALL ON FUNCTION public.bom_finish_feishu_version_sheet_rerun_if_needed(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.bom_finish_feishu_version_sheet_rerun_if_needed(uuid) TO anon;
GRANT EXECUTE ON FUNCTION public.bom_finish_feishu_version_sheet_rerun_if_needed(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.bom_finish_feishu_version_sheet_rerun_if_needed(uuid) TO service_role;
