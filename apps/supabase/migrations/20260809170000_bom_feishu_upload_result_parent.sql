-- 飞书上传任务：不可变结果快照 + 补传父子链路
ALTER TABLE public.bom_feishu_upload_jobs
  ADD COLUMN IF NOT EXISTS result jsonb,
  ADD COLUMN IF NOT EXISTS parent_job_id uuid REFERENCES public.bom_feishu_upload_jobs(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.bom_feishu_upload_jobs.result IS
  '任务结束时写入的不可变结果：{ok,fail,skip,counts,...}；详情优先读此字段而非 live bom_rows';
COMMENT ON COLUMN public.bom_feishu_upload_jobs.parent_job_id IS
  '补传任务指向原失败任务；原任务 last_message 计数不改写';

CREATE INDEX IF NOT EXISTS idx_bom_feishu_upload_jobs_parent
  ON public.bom_feishu_upload_jobs (parent_job_id)
  WHERE parent_job_id IS NOT NULL;

-- 去掉旧的两参数重载，避免 PostgREST 歧义；三参数版本含默认值可兼容原调用
DROP FUNCTION IF EXISTS public.bom_request_feishu_upload(uuid, uuid[]);

CREATE OR REPLACE FUNCTION public.bom_request_feishu_upload(
  p_batch_id uuid,
  p_row_ids uuid[] DEFAULT NULL::uuid[],
  p_parent_job_id uuid DEFAULT NULL::uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_job UUID;
  v_ids UUID[];
  v_bytes_total bigint;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM bom_batches b WHERE b.id = p_batch_id AND b.user_id = v_user) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  IF p_parent_job_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
      FROM public.bom_feishu_upload_jobs j
      WHERE j.id = p_parent_job_id
        AND j.batch_id = p_batch_id
        AND j.user_id = v_user
    ) THEN
      RAISE EXCEPTION 'invalid parent_job_id';
    END IF;
  END IF;

  IF p_row_ids IS NOT NULL AND cardinality(p_row_ids) > 0 THEN
    SELECT COALESCE(array_agg(s.id ORDER BY s.ord), ARRAY[]::uuid[])
    INTO v_ids
    FROM (
      SELECT br.id, k.ord
      FROM unnest(p_row_ids) WITH ORDINALITY AS k(rid, ord)
      JOIN bom_rows br ON br.id = k.rid AND br.batch_id = p_batch_id
      WHERE (br.status->>'local') = 'verified_ok'
        AND COALESCE(br.status->>'feishu', 'not_scanned') IN ('absent', 'error')
    ) s;
  ELSE
    SELECT COALESCE(array_agg(br.id ORDER BY br.created_at), ARRAY[]::uuid[])
    INTO v_ids
    FROM bom_rows br
    WHERE br.batch_id = p_batch_id
      AND (br.status->>'local') = 'verified_ok'
      AND COALESCE(br.status->>'feishu', 'not_scanned') IN ('absent', 'error');
  END IF;

  IF v_ids IS NULL OR cardinality(v_ids) = 0 THEN
    RAISE EXCEPTION 'no eligible rows';
  END IF;

  SELECT NULLIF(COALESCE(SUM(public.bom_row_aggregate_size_bytes(br.bom_row, br.status)), 0), 0)::bigint
  INTO v_bytes_total
  FROM public.bom_rows br
  WHERE br.id = ANY (v_ids);

  INSERT INTO public.bom_feishu_upload_jobs (
    batch_id, user_id, row_ids, status, progress_total, bytes_total, trigger_source, parent_job_id
  )
  VALUES (
    p_batch_id, v_user, v_ids, 'queued', cardinality(v_ids), v_bytes_total, 'web', p_parent_job_id
  )
  RETURNING id INTO v_job;

  RETURN v_job;
END;
$$;

COMMENT ON FUNCTION public.bom_request_feishu_upload(uuid, uuid[], uuid) IS
  '网页触发飞书上传；可选 p_parent_job_id 标记补传任务；p_row_ids 为空则全部 eligible 行';

REVOKE ALL ON FUNCTION public.bom_request_feishu_upload(uuid, uuid[], uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.bom_request_feishu_upload(uuid, uuid[], uuid) TO anon;
GRANT ALL ON FUNCTION public.bom_request_feishu_upload(uuid, uuid[], uuid) TO authenticated;
GRANT ALL ON FUNCTION public.bom_request_feishu_upload(uuid, uuid[], uuid) TO service_role;
