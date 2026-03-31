-- ============================================
-- BOM Lite 阶段 4：it-Artifactory 自动获取（worker）与异常可追溯
-- ============================================

ALTER TABLE bom_rows
  ADD COLUMN IF NOT EXISTS last_fetch_error TEXT;

COMMENT ON COLUMN bom_rows.last_fetch_error IS '阶段 4：自动下载失败等简要原因；校验成功或非异常路径时由刷新逻辑清空';

-- 供 worker 拉取待下载行：it-artifactory 链接、尚未在索引中命中期望 MD5
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
  WHERE br.status IN ('pending', 'error')
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

COMMENT ON FUNCTION bom_rows_for_it_download(INTEGER) IS '阶段 4：返回待由 worker 从 it-Artifactory 拉取的 BOM 行（service_role）';

REVOKE ALL ON FUNCTION bom_rows_for_it_download(INTEGER) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION bom_rows_for_it_download(INTEGER) FROM authenticated;
GRANT EXECUTE ON FUNCTION bom_rows_for_it_download(INTEGER) TO service_role;

-- 扫描结束后刷新状态：若仍为「待处理」且存在 last_fetch_error，则保持「异常」；进入校验终态时清空 last_fetch_error
CREATE OR REPLACE FUNCTION bom_refresh_local_found_statuses()
RETURNS INTEGER AS $$
DECLARE
  n INTEGER := 0;
BEGIN
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
  ) sub
  WHERE br.id = sub.id
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
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION bom_refresh_local_found_statuses() IS '阶段 3–4：扫描结束后按索引与 jsonb 收敛状态；last_fetch_error 存在且仍为待处理语义时保持异常';

REVOKE ALL ON FUNCTION bom_refresh_local_found_statuses() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION bom_refresh_local_found_statuses() FROM authenticated;
GRANT EXECUTE ON FUNCTION bom_refresh_local_found_statuses() TO service_role;
