-- bom_rows.status：由单一枚举改为 JSONB { local, ext }，本地与 ext 流程互不覆盖。
-- local: pending | await_manual_download | local_found | verified_ok | verified_fail | error
-- ext:   not_started | synced_or_skipped | error

ALTER TABLE bom_rows
  ADD COLUMN IF NOT EXISTS status_v2 JSONB NOT NULL DEFAULT '{"local":"pending","ext":"not_started"}'::jsonb;

UPDATE bom_rows br
SET status_v2 = CASE br.status::text
  WHEN 'pending' THEN '{"local":"pending","ext":"not_started"}'::jsonb
  WHEN 'await_manual_download' THEN '{"local":"await_manual_download","ext":"not_started"}'::jsonb
  WHEN 'local_found' THEN '{"local":"local_found","ext":"not_started"}'::jsonb
  WHEN 'verified_ok' THEN '{"local":"verified_ok","ext":"not_started"}'::jsonb
  WHEN 'verified_fail' THEN '{"local":"verified_fail","ext":"not_started"}'::jsonb
  WHEN 'error' THEN '{"local":"error","ext":"not_started"}'::jsonb
  WHEN 'synced_or_skipped' THEN '{"local":"verified_ok","ext":"synced_or_skipped"}'::jsonb
  ELSE '{"local":"pending","ext":"not_started"}'::jsonb
END;

DROP INDEX IF EXISTS idx_bom_rows_status;

ALTER TABLE bom_rows DROP COLUMN IF EXISTS status;

ALTER TABLE bom_rows RENAME COLUMN status_v2 TO status;

ALTER TABLE bom_rows
  ALTER COLUMN status SET DEFAULT '{"local":"pending","ext":"not_started"}'::jsonb;

COMMENT ON COLUMN bom_rows.status IS 'JSONB：local=it/扫描/校验维度；ext=转存维度；互斥更新由各写入方只改一侧';

CREATE INDEX IF NOT EXISTS idx_bom_rows_status_local ON bom_rows ((status->>'local'));
CREATE INDEX IF NOT EXISTS idx_bom_rows_status_ext ON bom_rows ((status->>'ext'));

ALTER TABLE bom_rows DROP CONSTRAINT IF EXISTS bom_rows_status_keys;

ALTER TABLE bom_rows ADD CONSTRAINT bom_rows_status_keys CHECK (
  status ? 'local'
  AND status ? 'ext'
  AND (status->>'local') IN (
    'pending',
    'await_manual_download',
    'local_found',
    'verified_ok',
    'verified_fail',
    'error'
  )
  AND (status->>'ext') IN ('not_started', 'synced_or_skipped', 'error')
);

-- ---------------------------------------------------------------------------
-- bom_rows_for_it_download
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION bom_rows_for_it_download(p_limit INTEGER DEFAULT 25)
RETURNS TABLE(id UUID, download_url TEXT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT br.id,
         bom_extract_download_url(br.bom_row) AS download_url
  FROM bom_rows br
  WHERE (br.status->>'local') IN ('pending', 'error')
    AND bom_url_looks_like_it_artifactory(bom_extract_download_url(br.bom_row))
    AND bom_extract_download_url(br.bom_row) ~ '^https?://'
    AND (
      bom_extract_expected_md5(br.bom_row) IS NULL
      OR NOT EXISTS (
        SELECT 1
        FROM local_file lf
        WHERE lf.md5 IS NOT NULL
          AND lf.md5 ~ '^[a-f0-9]{32}$'
          AND LOWER(lf.md5) = bom_extract_expected_md5(br.bom_row)
      )
    )
  ORDER BY br.updated_at ASC NULLS FIRST, br.created_at ASC
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 25), 100));
$$;

-- ---------------------------------------------------------------------------
-- bom_refresh_local_found_statuses（worker 扫描结束）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION bom_refresh_local_found_statuses()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  n INTEGER := 0;
BEGIN
  UPDATE bom_rows br
  SET
    status = jsonb_set(
      br.status,
      '{local}',
      to_jsonb(
        CASE
          WHEN sub.new_local = 'pending' AND br.last_fetch_error IS NOT NULL THEN 'error'
          ELSE sub.new_local
        END
      ),
      true
    ),
    last_fetch_error = CASE
      WHEN sub.new_local IN ('verified_ok', 'verified_fail', 'await_manual_download') THEN NULL
      ELSE br.last_fetch_error
    END
  FROM (
    SELECT
      br2.id,
      CASE
        WHEN bom_extract_expected_md5(br2.bom_row) ~ '^[a-f0-9]{32}$'
             AND EXISTS (
               SELECT 1
               FROM local_file lf
               WHERE lf.md5 IS NOT NULL
                 AND lf.md5 ~ '^[a-f0-9]{32}$'
                 AND LOWER(lf.md5) = bom_extract_expected_md5(br2.bom_row)
             )
          THEN 'verified_ok'
        WHEN bom_extract_expected_md5(br2.bom_row) ~ '^[a-f0-9]{32}$'
             AND EXISTS (
               SELECT 1
               FROM local_file lf
               WHERE lf.md5 IS NOT NULL
                 AND lf.md5 ~ '^[a-f0-9]{32}$'
                 AND LOWER(lf.md5) <> bom_extract_expected_md5(br2.bom_row)
                 AND bom_file_basename(lf.path) IS NOT NULL
                 AND bom_url_path_basename(bom_extract_download_url(br2.bom_row)) IS NOT NULL
                 AND bom_file_basename(lf.path) = bom_url_path_basename(bom_extract_download_url(br2.bom_row))
             )
          THEN 'verified_fail'
        WHEN NULLIF(BTRIM(COALESCE(bom_extract_download_url(br2.bom_row), '')), '') IS NOT NULL
             AND NOT bom_url_looks_like_it_artifactory(bom_extract_download_url(br2.bom_row))
             AND NOT (
               bom_extract_expected_md5(br2.bom_row) ~ '^[a-f0-9]{32}$'
               AND EXISTS (
                 SELECT 1
                 FROM local_file lf
                 WHERE lf.md5 IS NOT NULL
                   AND lf.md5 ~ '^[a-f0-9]{32}$'
                   AND LOWER(lf.md5) = bom_extract_expected_md5(br2.bom_row)
               )
             )
          THEN 'await_manual_download'
        ELSE 'pending'
      END AS new_local
    FROM bom_rows br2
  ) sub
  WHERE br.id = sub.id
    AND (br.status->>'ext') IS DISTINCT FROM 'synced_or_skipped'
    AND (
      (br.status->>'local') IS DISTINCT FROM (
        CASE
          WHEN sub.new_local = 'pending' AND br.last_fetch_error IS NOT NULL THEN 'error'
          ELSE sub.new_local
        END
      )
      OR br.last_fetch_error IS DISTINCT FROM (
        CASE
          WHEN sub.new_local IN ('verified_ok', 'verified_fail', 'await_manual_download') THEN NULL::text
          ELSE br.last_fetch_error
        END
      )
    );

  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

COMMENT ON FUNCTION bom_refresh_local_found_statuses() IS '扫描结束后仅更新 status.local；不修改 ext=synced_or_skipped 的行';

-- ---------------------------------------------------------------------------
-- bom_refresh_local_found_statuses_for_batch
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION bom_refresh_local_found_statuses_for_batch(p_batch_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  n INTEGER := 0;
  v_user UUID := auth.uid();
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM bom_batches b WHERE b.id = p_batch_id AND b.user_id = v_user) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  UPDATE bom_rows br
  SET
    status = jsonb_set(
      br.status,
      '{local}',
      to_jsonb(
        CASE
          WHEN sub.new_local = 'pending' AND br.last_fetch_error IS NOT NULL THEN 'error'
          ELSE sub.new_local
        END
      ),
      true
    ),
    last_fetch_error = CASE
      WHEN sub.new_local IN ('verified_ok', 'verified_fail', 'await_manual_download') THEN NULL
      ELSE br.last_fetch_error
    END
  FROM (
    SELECT
      br2.id,
      CASE
        WHEN bom_extract_expected_md5(br2.bom_row) ~ '^[a-f0-9]{32}$'
             AND EXISTS (
               SELECT 1
               FROM local_file lf
               WHERE lf.md5 IS NOT NULL
                 AND lf.md5 ~ '^[a-f0-9]{32}$'
                 AND LOWER(lf.md5) = bom_extract_expected_md5(br2.bom_row)
             )
          THEN 'verified_ok'
        WHEN bom_extract_expected_md5(br2.bom_row) ~ '^[a-f0-9]{32}$'
             AND EXISTS (
               SELECT 1
               FROM local_file lf
               WHERE lf.md5 IS NOT NULL
                 AND lf.md5 ~ '^[a-f0-9]{32}$'
                 AND LOWER(lf.md5) <> bom_extract_expected_md5(br2.bom_row)
                 AND bom_file_basename(lf.path) IS NOT NULL
                 AND bom_url_path_basename(bom_extract_download_url(br2.bom_row)) IS NOT NULL
                 AND bom_file_basename(lf.path) = bom_url_path_basename(bom_extract_download_url(br2.bom_row))
             )
          THEN 'verified_fail'
        WHEN NULLIF(BTRIM(COALESCE(bom_extract_download_url(br2.bom_row), '')), '') IS NOT NULL
             AND NOT bom_url_looks_like_it_artifactory(bom_extract_download_url(br2.bom_row))
             AND NOT (
               bom_extract_expected_md5(br2.bom_row) ~ '^[a-f0-9]{32}$'
               AND EXISTS (
                 SELECT 1
                 FROM local_file lf
                 WHERE lf.md5 IS NOT NULL
                   AND lf.md5 ~ '^[a-f0-9]{32}$'
                   AND LOWER(lf.md5) = bom_extract_expected_md5(br2.bom_row)
               )
             )
          THEN 'await_manual_download'
        ELSE 'pending'
      END AS new_local
    FROM bom_rows br2
    WHERE br2.batch_id = p_batch_id
  ) sub
  WHERE br.id = sub.id
    AND br.batch_id = p_batch_id
    AND (br.status->>'ext') IS DISTINCT FROM 'synced_or_skipped'
    AND (
      (br.status->>'local') IS DISTINCT FROM (
        CASE
          WHEN sub.new_local = 'pending' AND br.last_fetch_error IS NOT NULL THEN 'error'
          ELSE sub.new_local
        END
      )
      OR br.last_fetch_error IS DISTINCT FROM (
        CASE
          WHEN sub.new_local IN ('verified_ok', 'verified_fail', 'await_manual_download') THEN NULL::text
          ELSE br.last_fetch_error
        END
      )
    );

  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

COMMENT ON FUNCTION bom_refresh_local_found_statuses_for_batch(UUID) IS
  '按 local_file 重算该批次 status.local（跳过 ext=synced_or_skipped）';

-- ---------------------------------------------------------------------------
-- it 下载 eligible
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION bom_row_still_eligible_for_it_download(p_row_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM bom_rows br
    WHERE br.id = p_row_id
      AND (br.status->>'local') IN ('pending', 'error')
      AND bom_url_looks_like_it_artifactory(bom_extract_download_url(br.bom_row))
      AND bom_extract_download_url(br.bom_row) ~ '^https?://'
      AND (
        bom_extract_expected_md5(br.bom_row) IS NULL
        OR NOT EXISTS (
          SELECT 1
          FROM local_file lf
          WHERE lf.md5 IS NOT NULL
            AND lf.md5 ~ '^[a-f0-9]{32}$'
            AND LOWER(lf.md5) = bom_extract_expected_md5(br.bom_row)
        )
      )
  );
$$;

CREATE OR REPLACE FUNCTION bom_request_download(p_batch_id UUID, p_row_ids UUID[] DEFAULT NULL)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_job UUID;
  v_ids UUID[];
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
      WHERE (br.status->>'local') IN ('pending', 'error')
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
    ) s;
  ELSE
    SELECT COALESCE(array_agg(br.id ORDER BY br.created_at), ARRAY[]::uuid[])
    INTO v_ids
    FROM bom_rows br
    WHERE br.batch_id = p_batch_id
      AND (br.status->>'local') IN ('pending', 'error')
      AND bom_url_looks_like_it_artifactory(bom_extract_download_url(br.bom_row))
      AND bom_extract_download_url(br.bom_row) ~ '^https?://'
      AND (
        bom_extract_expected_md5(br.bom_row) IS NULL
        OR NOT EXISTS (
          SELECT 1 FROM local_file lf
          WHERE lf.md5 IS NOT NULL AND lf.md5 ~ '^[a-f0-9]{32}$'
            AND LOWER(lf.md5) = bom_extract_expected_md5(br.bom_row)
        )
      );
  END IF;

  IF v_ids IS NULL OR cardinality(v_ids) = 0 THEN
    RAISE EXCEPTION 'no eligible rows';
  END IF;

  INSERT INTO bom_download_jobs (batch_id, user_id, row_ids, status, progress_total, trigger_source)
  VALUES (p_batch_id, v_user, v_ids, 'queued', cardinality(v_ids), 'web')
  RETURNING id INTO v_job;

  RETURN v_job;
END;
$$;

-- ---------------------------------------------------------------------------
-- ext 同步
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION bom_request_ext_sync(p_batch_id UUID, p_row_ids UUID[] DEFAULT NULL)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_job UUID;
  v_ids UUID[];
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

  INSERT INTO bom_ext_sync_jobs (batch_id, user_id, row_ids, status, progress_total, trigger_source)
  VALUES (p_batch_id, v_user, v_ids, 'queued', cardinality(v_ids), 'web')
  RETURNING id INTO v_job;

  RETURN v_job;
END;
$$;

CREATE OR REPLACE FUNCTION bom_row_still_eligible_for_ext_sync(p_row_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM bom_rows br
    WHERE br.id = p_row_id
      AND (br.status->>'local') = 'verified_ok'
      AND (
        bom_extract_ext_url(br.bom_row) IS NULL
        OR BTRIM(bom_extract_ext_url(br.bom_row)) = ''
      )
  );
$$;
