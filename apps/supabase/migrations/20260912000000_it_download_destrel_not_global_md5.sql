-- IT / 分发拉取：不再因「MD5 已在 local_file 任意 path」整行跳过。
-- 同 MD5 由 worker 硬链到本次 destRel；跳过仅当 destRel 已是期望内容。

CREATE OR REPLACE FUNCTION public.bom_row_still_eligible_for_it_download(p_row_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM bom_rows br
    WHERE br.id = p_row_id
      AND bom_url_looks_like_it_artifactory(bom_extract_download_url(br.bom_row))
      AND bom_extract_download_url(br.bom_row) ~ '^https?://'
      AND (
        (br.status->>'local') IN ('pending', 'error')
        OR (
          (br.status->>'local') IN ('verified_ok', 'verified_fail', 'local_found')
          AND bom_extract_expected_md5(br.bom_row) ~ '^[a-f0-9]{32}$'
        )
      )
  );
$$;

COMMENT ON FUNCTION public.bom_row_still_eligible_for_it_download(uuid) IS
  'it 拉取：pending/error，或 verified_ok|verified_fail|local_found 且有期望 MD5；不因全局 local_file MD5 跳过（由 worker 硬链到 destRel）';

CREATE OR REPLACE FUNCTION public.bom_rows_for_it_download(p_limit integer DEFAULT 25)
RETURNS TABLE(id uuid, download_url text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO public
AS $$
  SELECT br.id,
         bom_extract_download_url(br.bom_row) AS download_url
  FROM bom_rows br
  WHERE (br.status->>'local') IN ('pending', 'error')
    AND bom_url_looks_like_it_artifactory(bom_extract_download_url(br.bom_row))
    AND bom_extract_download_url(br.bom_row) ~ '^https?://'
  ORDER BY br.updated_at ASC NULLS FIRST, br.created_at ASC
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 25), 100));
$$;

COMMENT ON FUNCTION public.bom_rows_for_it_download(integer) IS
  '返回待由 worker 从 it-Artifactory 拉取的 BOM 行；不因全局 MD5 索引跳过';

CREATE OR REPLACE FUNCTION public.bom_row_still_eligible_for_distribute_ext_pull(p_row_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM bom_rows br
    WHERE br.id = p_row_id
      AND bom_url_looks_like_it_artifactory(bom_extract_ext_url(br.bom_row))
      AND NULLIF(BTRIM(bom_extract_ext_url(br.bom_row)), '') ~ '^https?://'
      AND (
        (br.status->>'local') IN ('pending', 'error')
        OR (
          (br.status->>'local') IN ('verified_ok', 'verified_fail', 'local_found')
          AND bom_extract_expected_md5(br.bom_row) ~ '^[a-f0-9]{32}$'
        )
      )
  );
$$;

COMMENT ON FUNCTION public.bom_row_still_eligible_for_distribute_ext_pull(uuid) IS
  '分发 ext 拉取：与 it 拉取相同本地状态条件，URL 仅认 ext 列；不因全局 local_file MD5 跳过';

CREATE OR REPLACE FUNCTION public.bom_request_download(p_batch_id uuid, p_row_ids uuid[] DEFAULT NULL::uuid[])
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

  IF p_row_ids IS NOT NULL AND cardinality(p_row_ids) > 0 THEN
    SELECT COALESCE(array_agg(s.id ORDER BY s.ord), ARRAY[]::uuid[])
    INTO v_ids
    FROM (
      SELECT br.id, k.ord
      FROM unnest(p_row_ids) WITH ORDINALITY AS k(rid, ord)
      JOIN bom_rows br ON br.id = k.rid AND br.batch_id = p_batch_id
      WHERE bom_url_looks_like_it_artifactory(bom_extract_download_url(br.bom_row))
        AND bom_extract_download_url(br.bom_row) ~ '^https?://'
        AND (
          (br.status->>'local') IN ('pending', 'error')
          OR (
            (br.status->>'local') IN ('verified_ok', 'verified_fail', 'local_found')
            AND bom_extract_expected_md5(br.bom_row) ~ '^[a-f0-9]{32}$'
          )
        )
    ) s;
  ELSE
    SELECT COALESCE(array_agg(br.id ORDER BY br.created_at), ARRAY[]::uuid[])
    INTO v_ids
    FROM bom_rows br
    WHERE br.batch_id = p_batch_id
      AND bom_url_looks_like_it_artifactory(bom_extract_download_url(br.bom_row))
      AND bom_extract_download_url(br.bom_row) ~ '^https?://'
      AND (
        (br.status->>'local') IN ('pending', 'error')
        OR (
          (br.status->>'local') IN ('verified_ok', 'verified_fail', 'local_found')
          AND bom_extract_expected_md5(br.bom_row) ~ '^[a-f0-9]{32}$'
        )
      );
  END IF;

  IF v_ids IS NULL OR cardinality(v_ids) = 0 THEN
    RAISE EXCEPTION 'no eligible rows';
  END IF;

  SELECT NULLIF(COALESCE(SUM(public.bom_row_aggregate_size_bytes(br.bom_row, br.status)), 0), 0)::bigint
  INTO v_bytes_total
  FROM public.bom_rows br
  WHERE br.id = ANY (v_ids);

  INSERT INTO bom_download_jobs (batch_id, user_id, row_ids, status, progress_total, bytes_total, trigger_source)
  VALUES (p_batch_id, v_user, v_ids, 'queued', cardinality(v_ids), v_bytes_total, 'web')
  RETURNING id INTO v_job;

  RETURN v_job;
END;
$$;

COMMENT ON FUNCTION public.bom_request_download(uuid, uuid[]) IS
  '网页触发 it 拉取：不因全局 local_file MD5 跳过；worker 将硬链到 destRel';

CREATE OR REPLACE FUNCTION public.bom_request_distribute_ext_pull(p_batch_id uuid, p_row_ids uuid[] DEFAULT NULL::uuid[])
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

  IF p_row_ids IS NOT NULL AND cardinality(p_row_ids) > 0 THEN
    SELECT COALESCE(array_agg(s.id ORDER BY s.ord), ARRAY[]::uuid[])
    INTO v_ids
    FROM (
      SELECT br.id, k.ord
      FROM unnest(p_row_ids) WITH ORDINALITY AS k(rid, ord)
      JOIN bom_rows br ON br.id = k.rid AND br.batch_id = p_batch_id
      WHERE bom_url_looks_like_it_artifactory(bom_extract_ext_url(br.bom_row))
        AND NULLIF(BTRIM(bom_extract_ext_url(br.bom_row)), '') ~ '^https?://'
        AND (
          (br.status->>'local') IN ('pending', 'error')
          OR (
            (br.status->>'local') IN ('verified_ok', 'verified_fail', 'local_found')
            AND bom_extract_expected_md5(br.bom_row) ~ '^[a-f0-9]{32}$'
          )
        )
    ) s;
  ELSE
    SELECT COALESCE(array_agg(br.id ORDER BY br.created_at), ARRAY[]::uuid[])
    INTO v_ids
    FROM bom_rows br
    WHERE br.batch_id = p_batch_id
      AND bom_url_looks_like_it_artifactory(bom_extract_ext_url(br.bom_row))
      AND NULLIF(BTRIM(bom_extract_ext_url(br.bom_row)), '') ~ '^https?://'
      AND (
        (br.status->>'local') IN ('pending', 'error')
        OR (
          (br.status->>'local') IN ('verified_ok', 'verified_fail', 'local_found')
          AND bom_extract_expected_md5(br.bom_row) ~ '^[a-f0-9]{32}$'
        )
      );
  END IF;

  IF v_ids IS NULL OR cardinality(v_ids) = 0 THEN
    RAISE EXCEPTION 'no eligible rows';
  END IF;

  SELECT NULLIF(COALESCE(SUM(public.bom_row_aggregate_size_bytes(br.bom_row, br.status)), 0), 0)::bigint
  INTO v_bytes_total
  FROM public.bom_rows br
  WHERE br.id = ANY (v_ids);

  INSERT INTO bom_download_jobs (
    batch_id,
    user_id,
    row_ids,
    status,
    progress_total,
    bytes_total,
    trigger_source,
    pull_url_source
  )
  VALUES (
    p_batch_id,
    v_user,
    v_ids,
    'queued',
    cardinality(v_ids),
    v_bytes_total,
    'distribute_web',
    'ext_only'
  )
  RETURNING id INTO v_job;

  RETURN v_job;
END;
$$;

COMMENT ON FUNCTION public.bom_request_distribute_ext_pull(uuid, uuid[]) IS
  'BOM 分发页：从 ext 转存地址拉取至本地；不因全局 local_file MD5 跳过';

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

CREATE OR REPLACE FUNCTION public.bom_debug_distribute_ext_pull_eligibility(p_row_id uuid)
RETURNS TABLE(
    row_id uuid,
    batch_id uuid,
    local_status text,
    ext_url text,
    expected_md5 text,
    ext_url_present boolean,
    ext_url_is_http boolean,
    ext_url_looks_like_artifactory boolean,
    expected_md5_missing boolean,
    expected_md5_in_local_file boolean,
    local_status_allowed boolean,
    eligible boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO public
AS $$
  WITH base AS (
    SELECT
      br.id AS row_id,
      br.batch_id,
      br.status->>'local' AS local_status,
      NULLIF(BTRIM(bom_extract_ext_url(br.bom_row)), '') AS ext_url,
      bom_extract_expected_md5(br.bom_row) AS expected_md5
    FROM bom_rows br
    WHERE br.id = p_row_id
  )
  SELECT
    b.row_id,
    b.batch_id,
    b.local_status,
    b.ext_url,
    b.expected_md5,
    (b.ext_url IS NOT NULL) AS ext_url_present,
    (b.ext_url IS NOT NULL AND b.ext_url ~ '^https?://') AS ext_url_is_http,
    bom_url_looks_like_it_artifactory(b.ext_url) AS ext_url_looks_like_artifactory,
    (b.expected_md5 IS NULL) AS expected_md5_missing,
    EXISTS (
      SELECT 1
      FROM local_file lf
      WHERE lf.md5 IS NOT NULL
        AND lf.md5 ~ '^[a-f0-9]{32}$'
        AND LOWER(lf.md5) = b.expected_md5
    ) AS expected_md5_in_local_file,
    (
      b.local_status IN ('pending', 'error')
      OR (
        b.local_status IN ('verified_ok', 'verified_fail', 'local_found')
        AND b.expected_md5 ~ '^[a-f0-9]{32}$'
      )
    ) AS local_status_allowed,
    (
      b.ext_url IS NOT NULL
      AND b.ext_url ~ '^https?://'
      AND bom_url_looks_like_it_artifactory(b.ext_url)
      AND (
        b.local_status IN ('pending', 'error')
        OR (
          b.local_status IN ('verified_ok', 'verified_fail', 'local_found')
          AND b.expected_md5 ~ '^[a-f0-9]{32}$'
        )
      )
    ) AS eligible
  FROM base b;
$$;
