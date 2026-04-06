-- 按当前 local_file 索引重算指定批次内 bom_rows 状态（不修改 synced_or_skipped）。
-- 用于网页打开/刷新批次时与索引对齐，避免本地文件已 prune 而行状态仍停留在校验通过等。

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
    status = CASE
      WHEN sub.new_status = 'pending' AND br.last_fetch_error IS NOT NULL THEN 'error'::bom_row_status
      ELSE sub.new_status::bom_row_status
    END,
    last_fetch_error = CASE
      WHEN sub.new_status IN ('verified_ok', 'verified_fail', 'await_manual_download') THEN NULL
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
      END AS new_status
    FROM bom_rows br2
    WHERE br2.batch_id = p_batch_id
  ) sub
  WHERE br.id = sub.id
    AND br.batch_id = p_batch_id
    AND br.status <> 'synced_or_skipped'::bom_row_status
    AND (
      br.status IS DISTINCT FROM (
        CASE
          WHEN sub.new_status = 'pending' AND br.last_fetch_error IS NOT NULL THEN 'error'::bom_row_status
          ELSE sub.new_status::bom_row_status
        END
      )
      OR br.last_fetch_error IS DISTINCT FROM (
        CASE
          WHEN sub.new_status IN ('verified_ok', 'verified_fail', 'await_manual_download') THEN NULL::text
          ELSE br.last_fetch_error
        END
      )
    );

  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

COMMENT ON FUNCTION bom_refresh_local_found_statuses_for_batch(UUID) IS
  '认证用户：按当前 local_file 重算该批次内行状态（跳过 synced_or_skipped）；打开批次页时可调用以对齐索引';

REVOKE ALL ON FUNCTION bom_refresh_local_found_statuses_for_batch(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION bom_refresh_local_found_statuses_for_batch(UUID) TO authenticated;
