-- 一键同步流水线：网页入队，bom-scanner-worker 编排子任务（拉取/ext/飞书等仍各插一行）

CREATE TABLE IF NOT EXISTS public.bom_sync_pipeline_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES public.bom_batches(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  row_ids uuid[],
  do_ext boolean NOT NULL DEFAULT true,
  do_feishu boolean NOT NULL DEFAULT true,
  enrich_md5 boolean NOT NULL DEFAULT true,
  status public.bom_download_job_status NOT NULL DEFAULT 'queued',
  phase text NOT NULL DEFAULT 'queued',
  last_message text,
  current_child_job_id uuid,
  current_child_kind text,
  cancel_requested boolean NOT NULL DEFAULT false,
  trigger_source text NOT NULL DEFAULT 'web',
  started_at timestamptz,
  heartbeat_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.bom_sync_pipeline_jobs IS
  '一键同步编排任务：worker 按阶段入队既有子任务表；本表不替代拉取/ext/飞书任务行';
COMMENT ON COLUMN public.bom_sync_pipeline_jobs.row_ids IS
  '限定行；NULL 或空表示整版';
COMMENT ON COLUMN public.bom_sync_pipeline_jobs.phase IS
  'queued/enrich_md5/download/wait_verified/ext_sync/feishu_scan/feishu_upload/version_sheet/done';
COMMENT ON COLUMN public.bom_sync_pipeline_jobs.current_child_kind IS
  'download | ext_sync | feishu_scan | feishu_upload | version_sheet';

CREATE INDEX IF NOT EXISTS idx_bom_sync_pipeline_jobs_batch
  ON public.bom_sync_pipeline_jobs (batch_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bom_sync_pipeline_jobs_status
  ON public.bom_sync_pipeline_jobs (status);

DROP TRIGGER IF EXISTS update_bom_sync_pipeline_jobs_updated_at ON public.bom_sync_pipeline_jobs;
CREATE TRIGGER update_bom_sync_pipeline_jobs_updated_at
  BEFORE UPDATE ON public.bom_sync_pipeline_jobs
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.bom_sync_pipeline_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full bom_sync_pipeline_jobs" ON public.bom_sync_pipeline_jobs;
CREATE POLICY "Service role full bom_sync_pipeline_jobs"
  ON public.bom_sync_pipeline_jobs
  TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "Users read own batch sync pipeline jobs" ON public.bom_sync_pipeline_jobs;
CREATE POLICY "Users read own batch sync pipeline jobs"
  ON public.bom_sync_pipeline_jobs
  FOR SELECT
  USING (
    auth.role() = 'service_role'
    OR EXISTS (
      SELECT 1 FROM public.bom_batches b
      WHERE b.id = bom_sync_pipeline_jobs.batch_id
        AND b.user_id = auth.uid()
    )
  );

CREATE OR REPLACE FUNCTION public.bom_request_sync_pipeline(
  p_batch_id uuid,
  p_row_ids uuid[] DEFAULT NULL::uuid[],
  p_do_ext boolean DEFAULT true,
  p_do_feishu boolean DEFAULT true,
  p_enrich_md5 boolean DEFAULT true
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_job uuid;
  v_ids uuid[];
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.bom_batches b
    WHERE b.id = p_batch_id AND b.user_id = v_user
  ) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.bom_sync_pipeline_jobs j
    WHERE j.batch_id = p_batch_id
      AND j.status IN (
        'queued'::public.bom_download_job_status,
        'running'::public.bom_download_job_status
      )
  ) THEN
    RAISE EXCEPTION 'pipeline already active';
  END IF;

  IF p_row_ids IS NOT NULL AND cardinality(p_row_ids) > 0 THEN
    SELECT COALESCE(array_agg(s.id ORDER BY s.ord), ARRAY[]::uuid[])
    INTO v_ids
    FROM (
      SELECT br.id, k.ord
      FROM unnest(p_row_ids) WITH ORDINALITY AS k(rid, ord)
      JOIN public.bom_rows br ON br.id = k.rid AND br.batch_id = p_batch_id
    ) s;
    IF v_ids IS NULL OR cardinality(v_ids) <> cardinality(p_row_ids) THEN
      RAISE EXCEPTION 'invalid row_ids';
    END IF;
  ELSE
    v_ids := NULL;
  END IF;

  INSERT INTO public.bom_sync_pipeline_jobs (
    batch_id, user_id, row_ids, do_ext, do_feishu, enrich_md5,
    status, phase, trigger_source
  )
  VALUES (
    p_batch_id, v_user, v_ids,
    COALESCE(p_do_ext, true),
    COALESCE(p_do_feishu, true),
    COALESCE(p_enrich_md5, true),
    'queued'::public.bom_download_job_status,
    'queued',
    'web'
  )
  RETURNING id INTO v_job;

  RETURN v_job;
END;
$$;

COMMENT ON FUNCTION public.bom_request_sync_pipeline(uuid, uuid[], boolean, boolean, boolean) IS
  '网页入队一键同步；同一版本已有 queued/running 则拒绝';

CREATE OR REPLACE FUNCTION public.bom_claim_sync_pipeline_job()
RETURNS TABLE(
  id uuid,
  batch_id uuid,
  user_id uuid,
  row_ids uuid[],
  do_ext boolean,
  do_feishu boolean,
  enrich_md5 boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  picked uuid;
BEGIN
  SELECT j2.id
  INTO picked
  FROM public.bom_sync_pipeline_jobs j2
  WHERE j2.status = 'queued'::public.bom_download_job_status
  ORDER BY j2.created_at ASC
  LIMIT 1
  FOR UPDATE SKIP LOCKED;

  IF picked IS NULL THEN
    RETURN;
  END IF;

  UPDATE public.bom_sync_pipeline_jobs j
  SET status = 'running'::public.bom_download_job_status,
      phase = CASE WHEN j.enrich_md5 THEN 'enrich_md5' ELSE 'download' END,
      updated_at = now(),
      started_at = COALESCE(j.started_at, now()),
      heartbeat_at = now(),
      last_message = '已抢占，开始编排'
  WHERE j.id = picked;

  RETURN QUERY
  SELECT j.id, j.batch_id, j.user_id, j.row_ids, j.do_ext, j.do_feishu, j.enrich_md5
  FROM public.bom_sync_pipeline_jobs j
  WHERE j.id = picked;
END;
$$;

COMMENT ON FUNCTION public.bom_claim_sync_pipeline_job() IS
  'worker 抢占一条排队中的一键同步任务';

CREATE OR REPLACE FUNCTION public.bom_fail_stale_sync_pipeline_jobs(p_stale_seconds integer DEFAULT 900)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  n integer := 0;
  v_cutoff timestamptz;
BEGIN
  IF p_stale_seconds IS NULL OR p_stale_seconds < 60 THEN
    p_stale_seconds := 900;
  END IF;
  v_cutoff := now() - (p_stale_seconds::text || ' seconds')::interval;

  UPDATE public.bom_sync_pipeline_jobs j
  SET status = 'failed'::public.bom_download_job_status,
      finished_at = now(),
      last_message = 'worker 心跳超时（可能进程崩溃或网络中断）',
      updated_at = now(),
      current_child_job_id = NULL,
      current_child_kind = NULL
  WHERE j.status = 'running'::public.bom_download_job_status
    AND COALESCE(j.heartbeat_at, j.updated_at, j.started_at) < v_cutoff;

  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

CREATE OR REPLACE FUNCTION public.bom_cancel_sync_pipeline_job(p_job_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_status public.bom_download_job_status;
  v_cancel boolean;
  v_child uuid;
  v_kind text;
  v_ok boolean;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  SELECT j.status, j.cancel_requested, j.current_child_job_id, j.current_child_kind
  INTO v_status, v_cancel, v_child, v_kind
  FROM public.bom_sync_pipeline_jobs j
  WHERE j.id = p_job_id
    AND EXISTS (
      SELECT 1 FROM public.bom_batches b
      WHERE b.id = j.batch_id AND b.user_id = v_user
    )
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF v_status IN (
    'succeeded'::public.bom_download_job_status,
    'cancelled'::public.bom_download_job_status
  ) THEN
    RETURN true;
  END IF;

  IF v_status = 'queued'::public.bom_download_job_status THEN
    UPDATE public.bom_sync_pipeline_jobs
    SET status = 'cancelled'::public.bom_download_job_status,
        finished_at = now(),
        cancel_requested = false,
        last_message = '用户取消',
        updated_at = now()
    WHERE id = p_job_id;
    RETURN true;
  END IF;

  IF v_status = 'failed'::public.bom_download_job_status THEN
    UPDATE public.bom_sync_pipeline_jobs
    SET status = 'cancelled'::public.bom_download_job_status,
        cancel_requested = false,
        last_message = COALESCE(last_message, '用户取消'),
        updated_at = now()
    WHERE id = p_job_id;
    RETURN true;
  END IF;

  -- running：打标；二次调用强制 cancelled
  IF v_cancel THEN
    UPDATE public.bom_sync_pipeline_jobs
    SET status = 'cancelled'::public.bom_download_job_status,
        finished_at = now(),
        cancel_requested = false,
        last_message = '用户取消',
        current_child_job_id = NULL,
        current_child_kind = NULL,
        updated_at = now()
    WHERE id = p_job_id;
    RETURN true;
  END IF;

  UPDATE public.bom_sync_pipeline_jobs
  SET cancel_requested = true,
      last_message = '取消请求已提交',
      updated_at = now()
  WHERE id = p_job_id;

  IF v_child IS NOT NULL THEN
    BEGIN
      IF v_kind = 'download' THEN
        v_ok := public.bom_cancel_download_job(v_child);
      ELSIF v_kind = 'ext_sync' THEN
        v_ok := public.bom_cancel_ext_sync_job(v_child);
      ELSIF v_kind = 'feishu_upload' THEN
        v_ok := public.bom_cancel_feishu_upload_job(v_child);
      END IF;
    EXCEPTION
      WHEN OTHERS THEN
        NULL;
    END;
  END IF;

  RETURN true;
END;
$$;

COMMENT ON FUNCTION public.bom_cancel_sync_pipeline_job(uuid) IS
  '取消排队中的流水线；running 打标并尝试取消当前子任务';

-- worker 以流水线发起人身份入队子任务（跳过 auth.uid）
CREATE OR REPLACE FUNCTION public.bom_worker_enqueue_download(
  p_batch_id uuid,
  p_user_id uuid,
  p_row_ids uuid[] DEFAULT NULL::uuid[]
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  v_job uuid;
  v_ids uuid[];
  v_bytes_total bigint;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'user_id required';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.bom_batches b
    WHERE b.id = p_batch_id AND b.user_id = p_user_id
  ) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  IF p_row_ids IS NOT NULL AND cardinality(p_row_ids) > 0 THEN
    SELECT COALESCE(array_agg(s.id ORDER BY s.ord), ARRAY[]::uuid[])
    INTO v_ids
    FROM (
      SELECT br.id, k.ord
      FROM unnest(p_row_ids) WITH ORDINALITY AS k(rid, ord)
      JOIN public.bom_rows br ON br.id = k.rid AND br.batch_id = p_batch_id
      WHERE public.bom_url_looks_like_it_artifactory(public.bom_extract_download_url(br.bom_row))
        AND public.bom_extract_download_url(br.bom_row) ~ '^https?://'
        AND (
          public.bom_extract_expected_md5(br.bom_row) IS NULL
          OR NOT EXISTS (
            SELECT 1 FROM public.local_file lf
            WHERE lf.md5 IS NOT NULL AND lf.md5 ~ '^[a-f0-9]{32}$'
              AND LOWER(lf.md5) = public.bom_extract_expected_md5(br.bom_row)
          )
        )
        AND (
          (br.status->>'local') IN ('pending', 'error')
          OR (
            (br.status->>'local') IN ('verified_ok', 'verified_fail', 'local_found')
            AND public.bom_extract_expected_md5(br.bom_row) ~ '^[a-f0-9]{32}$'
          )
        )
    ) s;
  ELSE
    SELECT COALESCE(array_agg(br.id ORDER BY br.created_at), ARRAY[]::uuid[])
    INTO v_ids
    FROM public.bom_rows br
    WHERE br.batch_id = p_batch_id
      AND public.bom_url_looks_like_it_artifactory(public.bom_extract_download_url(br.bom_row))
      AND public.bom_extract_download_url(br.bom_row) ~ '^https?://'
      AND (
        public.bom_extract_expected_md5(br.bom_row) IS NULL
        OR NOT EXISTS (
          SELECT 1 FROM public.local_file lf
          WHERE lf.md5 IS NOT NULL AND lf.md5 ~ '^[a-f0-9]{32}$'
            AND LOWER(lf.md5) = public.bom_extract_expected_md5(br.bom_row)
        )
      )
      AND (
        (br.status->>'local') IN ('pending', 'error')
        OR (
          (br.status->>'local') IN ('verified_ok', 'verified_fail', 'local_found')
          AND public.bom_extract_expected_md5(br.bom_row) ~ '^[a-f0-9]{32}$'
        )
      );
  END IF;

  IF v_ids IS NULL OR cardinality(v_ids) = 0 THEN
    RETURN NULL;
  END IF;

  SELECT NULLIF(COALESCE(SUM(public.bom_row_aggregate_size_bytes(br.bom_row, br.status)), 0), 0)::bigint
  INTO v_bytes_total
  FROM public.bom_rows br
  WHERE br.id = ANY (v_ids);

  INSERT INTO public.bom_download_jobs (
    batch_id, user_id, row_ids, status, progress_total, bytes_total, trigger_source
  )
  VALUES (
    p_batch_id, p_user_id, v_ids, 'queued', cardinality(v_ids), v_bytes_total, 'pipeline'
  )
  RETURNING id INTO v_job;

  RETURN v_job;
END;
$$;

CREATE OR REPLACE FUNCTION public.bom_worker_enqueue_ext_sync(
  p_batch_id uuid,
  p_user_id uuid,
  p_row_ids uuid[] DEFAULT NULL::uuid[]
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  v_job uuid;
  v_ids uuid[];
  v_bytes_total bigint;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'user_id required';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.bom_batches b
    WHERE b.id = p_batch_id AND b.user_id = p_user_id
  ) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  IF p_row_ids IS NOT NULL AND cardinality(p_row_ids) > 0 THEN
    SELECT COALESCE(array_agg(s.id ORDER BY s.ord), ARRAY[]::uuid[])
    INTO v_ids
    FROM (
      SELECT br.id, k.ord
      FROM unnest(p_row_ids) WITH ORDINALITY AS k(rid, ord)
      JOIN public.bom_rows br ON br.id = k.rid AND br.batch_id = p_batch_id
      WHERE (br.status->>'local') = 'verified_ok'
        AND (
          public.bom_extract_ext_url(br.bom_row) IS NULL
          OR BTRIM(public.bom_extract_ext_url(br.bom_row)) = ''
        )
    ) s;
  ELSE
    SELECT COALESCE(array_agg(br.id ORDER BY br.created_at), ARRAY[]::uuid[])
    INTO v_ids
    FROM public.bom_rows br
    WHERE br.batch_id = p_batch_id
      AND (br.status->>'local') = 'verified_ok'
      AND (
        public.bom_extract_ext_url(br.bom_row) IS NULL
        OR BTRIM(public.bom_extract_ext_url(br.bom_row)) = ''
      );
  END IF;

  IF v_ids IS NULL OR cardinality(v_ids) = 0 THEN
    RETURN NULL;
  END IF;

  SELECT NULLIF(COALESCE(SUM(public.bom_row_aggregate_size_bytes(br.bom_row, br.status)), 0), 0)::bigint
  INTO v_bytes_total
  FROM public.bom_rows br
  WHERE br.id = ANY (v_ids);

  INSERT INTO public.bom_ext_sync_jobs (
    batch_id, user_id, row_ids, status, progress_total, bytes_total, trigger_source
  )
  VALUES (
    p_batch_id, p_user_id, v_ids, 'queued', cardinality(v_ids), v_bytes_total, 'pipeline'
  )
  RETURNING id INTO v_job;

  RETURN v_job;
END;
$$;

CREATE OR REPLACE FUNCTION public.bom_worker_enqueue_feishu_upload(
  p_batch_id uuid,
  p_user_id uuid,
  p_row_ids uuid[] DEFAULT NULL::uuid[]
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  v_job uuid;
  v_ids uuid[];
  v_bytes_total bigint;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'user_id required';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.bom_batches b
    WHERE b.id = p_batch_id AND b.user_id = p_user_id
  ) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  IF p_row_ids IS NOT NULL AND cardinality(p_row_ids) > 0 THEN
    SELECT COALESCE(array_agg(s.id ORDER BY s.ord), ARRAY[]::uuid[])
    INTO v_ids
    FROM (
      SELECT br.id, k.ord
      FROM unnest(p_row_ids) WITH ORDINALITY AS k(rid, ord)
      JOIN public.bom_rows br ON br.id = k.rid AND br.batch_id = p_batch_id
      WHERE (br.status->>'local') = 'verified_ok'
        AND COALESCE(br.status->>'feishu', 'not_scanned') IN ('absent', 'error')
    ) s;
  ELSE
    SELECT COALESCE(array_agg(br.id ORDER BY br.created_at), ARRAY[]::uuid[])
    INTO v_ids
    FROM public.bom_rows br
    WHERE br.batch_id = p_batch_id
      AND (br.status->>'local') = 'verified_ok'
      AND COALESCE(br.status->>'feishu', 'not_scanned') IN ('absent', 'error');
  END IF;

  IF v_ids IS NULL OR cardinality(v_ids) = 0 THEN
    RETURN NULL;
  END IF;

  SELECT NULLIF(COALESCE(SUM(public.bom_row_aggregate_size_bytes(br.bom_row, br.status)), 0), 0)::bigint
  INTO v_bytes_total
  FROM public.bom_rows br
  WHERE br.id = ANY (v_ids);

  INSERT INTO public.bom_feishu_upload_jobs (
    batch_id, user_id, row_ids, status, progress_total, bytes_total, trigger_source
  )
  VALUES (
    p_batch_id, p_user_id, v_ids, 'queued', cardinality(v_ids), v_bytes_total, 'pipeline'
  )
  RETURNING id INTO v_job;

  RETURN v_job;
END;
$$;

REVOKE ALL ON FUNCTION public.bom_request_sync_pipeline(uuid, uuid[], boolean, boolean, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.bom_request_sync_pipeline(uuid, uuid[], boolean, boolean, boolean) TO anon;
GRANT EXECUTE ON FUNCTION public.bom_request_sync_pipeline(uuid, uuid[], boolean, boolean, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.bom_request_sync_pipeline(uuid, uuid[], boolean, boolean, boolean) TO service_role;

REVOKE ALL ON FUNCTION public.bom_claim_sync_pipeline_job() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.bom_claim_sync_pipeline_job() TO service_role;

REVOKE ALL ON FUNCTION public.bom_fail_stale_sync_pipeline_jobs(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.bom_fail_stale_sync_pipeline_jobs(integer) TO service_role;

REVOKE ALL ON FUNCTION public.bom_cancel_sync_pipeline_job(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.bom_cancel_sync_pipeline_job(uuid) TO anon;
GRANT EXECUTE ON FUNCTION public.bom_cancel_sync_pipeline_job(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.bom_cancel_sync_pipeline_job(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.bom_worker_enqueue_download(uuid, uuid, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.bom_worker_enqueue_download(uuid, uuid, uuid[]) TO service_role;

REVOKE ALL ON FUNCTION public.bom_worker_enqueue_ext_sync(uuid, uuid, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.bom_worker_enqueue_ext_sync(uuid, uuid, uuid[]) TO service_role;

REVOKE ALL ON FUNCTION public.bom_worker_enqueue_feishu_upload(uuid, uuid, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.bom_worker_enqueue_feishu_upload(uuid, uuid, uuid[]) TO service_role;

GRANT ALL ON TABLE public.bom_sync_pipeline_jobs TO anon;
GRANT ALL ON TABLE public.bom_sync_pipeline_jobs TO authenticated;
GRANT ALL ON TABLE public.bom_sync_pipeline_jobs TO service_role;
