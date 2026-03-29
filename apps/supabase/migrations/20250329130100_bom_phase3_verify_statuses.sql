-- ============================================
-- BOM Lite 阶段 3：MD5 校验结果与状态收敛（扫描结束后由 bom_finalize_scan 调用）
-- ============================================

CREATE OR REPLACE FUNCTION bom_file_basename(p_path TEXT)
RETURNS TEXT AS $$
BEGIN
  IF p_path IS NULL OR BTRIM(p_path) = '' THEN
    RETURN NULL;
  END IF;
  RETURN LOWER(regexp_replace(BTRIM(p_path), '^.*/', ''));
END;
$$ LANGUAGE plpgsql IMMUTABLE;

COMMENT ON FUNCTION bom_file_basename(TEXT) IS '取路径最后一段（小写），用于与下载 URL 的文件名片段比对';

CREATE OR REPLACE FUNCTION bom_url_path_basename(p TEXT)
RETURNS TEXT AS $$
DECLARE
  t TEXT;
BEGIN
  IF p IS NULL OR BTRIM(p) = '' THEN
    RETURN NULL;
  END IF;
  t := BTRIM(p);
  t := regexp_replace(t, '^[a-z][a-z0-9+.-]*://[^/]+', '', 'i');
  t := regexp_replace(t, '\\?.*$', '');
  t := regexp_replace(t, '.*/', '');
  RETURN NULLIF(LOWER(t), '');
END;
$$ LANGUAGE plpgsql IMMUTABLE;

COMMENT ON FUNCTION bom_url_path_basename(TEXT) IS '从下载路径/URL 提取文件名（小写），去掉协议、主机与查询串';

CREATE OR REPLACE FUNCTION bom_url_looks_like_it_artifactory(p TEXT)
RETURNS BOOLEAN AS $$
BEGIN
  IF p IS NULL OR BTRIM(p) = '' THEN
    RETURN false;
  END IF;
  RETURN BTRIM(p) ~* 'artifactory';
END;
$$ LANGUAGE plpgsql IMMUTABLE;

COMMENT ON FUNCTION bom_url_looks_like_it_artifactory(TEXT) IS '粗判是否为 it-Artifactory 类链接（阶段 4 自动下载）；其它来源走待人工下载';

CREATE OR REPLACE FUNCTION bom_extract_download_url(p_row JSONB)
RETURNS TEXT AS $$
DECLARE
  cfg JSONB;
  key_name TEXT;
  v TEXT;
BEGIN
  IF p_row IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT value INTO cfg FROM system_settings WHERE key = 'bom_scanner' LIMIT 1;
  IF cfg IS NULL THEN
    RETURN NULL;
  END IF;

  FOR key_name IN
    SELECT jsonb_array_elements_text(COALESCE(cfg->'jsonKeyMap'->'downloadUrl', '[]'::jsonb))
  LOOP
    v := NULLIF(BTRIM(p_row ->> key_name), '');
    IF v IS NOT NULL THEN
      RETURN v;
    END IF;
  END LOOP;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE;

COMMENT ON FUNCTION bom_extract_download_url(JSONB) IS '按 bom_scanner.jsonKeyMap.downloadUrl 从 BOM 行提取下载路径/URL';

CREATE OR REPLACE FUNCTION bom_refresh_local_found_statuses()
RETURNS INTEGER AS $$
DECLARE
  n INTEGER := 0;
BEGIN
  UPDATE bom_rows br
  SET status = sub.new_status::bom_row_status
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
    AND br.status IS DISTINCT FROM sub.new_status::bom_row_status;

  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION bom_refresh_local_found_statuses() IS '阶段 3：扫描结束后按索引与 jsonb 收敛状态（verified_ok / verified_fail / await_manual_download / pending）；不修改 synced_or_skipped';

-- SECURITY DEFINER 会绕过 RLS；仅允许 service_role（worker 完成扫描时）调用
REVOKE ALL ON FUNCTION bom_refresh_local_found_statuses() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION bom_refresh_local_found_statuses() FROM authenticated;
GRANT EXECUTE ON FUNCTION bom_refresh_local_found_statuses() TO service_role;
