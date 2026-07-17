-- 入队时写入 bytes_total（按 row_ids 汇总 bom_row_aggregate_size_bytes），供任务页速度/ETA

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
          bom_extract_expected_md5(br.bom_row) IS NULL
          OR NOT EXISTS (
            SELECT 1 FROM local_file lf
            WHERE lf.md5 IS NOT NULL AND lf.md5 ~ '^[a-f0-9]{32}$'
              AND LOWER(lf.md5) = bom_extract_expected_md5(br.bom_row)
          )
        )
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
        bom_extract_expected_md5(br.bom_row) IS NULL
        OR NOT EXISTS (
          SELECT 1 FROM local_file lf
          WHERE lf.md5 IS NOT NULL AND lf.md5 ~ '^[a-f0-9]{32}$'
            AND LOWER(lf.md5) = bom_extract_expected_md5(br.bom_row)
        )
      )
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
  'BOM 分发页：仅从 ext 转存地址拉取至本地（worker 使用 bom_row_distribute_ext_pull_targets）；入队写入 bytes_total';

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
          bom_extract_expected_md5(br.bom_row) IS NULL
          OR NOT EXISTS (
            SELECT 1 FROM local_file lf
            WHERE lf.md5 IS NOT NULL AND lf.md5 ~ '^[a-f0-9]{32}$'
              AND LOWER(lf.md5) = bom_extract_expected_md5(br.bom_row)
          )
        )
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
        bom_extract_expected_md5(br.bom_row) IS NULL
        OR NOT EXISTS (
          SELECT 1 FROM local_file lf
          WHERE lf.md5 IS NOT NULL AND lf.md5 ~ '^[a-f0-9]{32}$'
            AND LOWER(lf.md5) = bom_extract_expected_md5(br.bom_row)
        )
      )
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
  '网页触发 it 拉取：p_row_ids 为空则当前批次全部 eligible 行（仅 downloadUrl）；入队写入 bytes_total';

CREATE OR REPLACE FUNCTION public.bom_request_ext_sync(p_batch_id uuid, p_row_ids uuid[] DEFAULT NULL::uuid[])
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
      WHERE (br.status->>'local') = 'verified_ok'
        AND (
          bom_extract_ext_url(br.bom_row) IS NULL
          OR BTRIM(bom_extract_ext_url(br.bom_row)) = ''
        )
    ) s;
  ELSE
    SELECT COALESCE(array_agg(br.id ORDER BY br.created_at), ARRAY[]::uuid[])
    INTO v_ids
    FROM bom_rows br
    WHERE br.batch_id = p_batch_id
      AND (br.status->>'local') = 'verified_ok'
      AND (
        bom_extract_ext_url(br.bom_row) IS NULL
        OR BTRIM(bom_extract_ext_url(br.bom_row)) = ''
      );
  END IF;

  IF v_ids IS NULL OR cardinality(v_ids) = 0 THEN
    RAISE EXCEPTION 'no eligible rows';
  END IF;

  SELECT NULLIF(COALESCE(SUM(public.bom_row_aggregate_size_bytes(br.bom_row, br.status)), 0), 0)::bigint
  INTO v_bytes_total
  FROM public.bom_rows br
  WHERE br.id = ANY (v_ids);

  INSERT INTO bom_ext_sync_jobs (batch_id, user_id, row_ids, status, progress_total, bytes_total, trigger_source)
  VALUES (p_batch_id, v_user, v_ids, 'queued', cardinality(v_ids), v_bytes_total, 'web')
  RETURNING id INTO v_job;

  RETURN v_job;
END;
$$;

COMMENT ON FUNCTION public.bom_request_ext_sync(uuid, uuid[]) IS
  '网页触发 ext 同步：p_row_ids 为空则当前批次全部「校验通过且尚无 ext_url」行；入队写入 bytes_total';

CREATE OR REPLACE FUNCTION public.bom_request_feishu_upload(p_batch_id uuid, p_row_ids uuid[] DEFAULT NULL::uuid[])
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

  INSERT INTO public.bom_feishu_upload_jobs (batch_id, user_id, row_ids, status, progress_total, bytes_total, trigger_source)
  VALUES (p_batch_id, v_user, v_ids, 'queued', cardinality(v_ids), v_bytes_total, 'web')
  RETURNING id INTO v_job;

  RETURN v_job;
END;
$$;

COMMENT ON FUNCTION public.bom_request_feishu_upload(uuid, uuid[]) IS
  '网页触发飞书上传：p_row_ids 为空则当前批次全部「本地校验通过且飞书 absent|error」行；入队写入 bytes_total';
