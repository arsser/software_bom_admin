-- 网页 it 下载写入的 local_file 使用 last_seen_scan_job_id = NULL；原 finalize 会
-- DELETE WHERE last_seen_scan_job_id IS DISTINCT FROM p_job_id，导致 NULL 被误删。
-- 仅 prune「曾绑定过某次扫描任务、且本次未再见到」的行，保留 NULL（下载直写）直到被某次 walk 认领。

CREATE OR REPLACE FUNCTION bom_finalize_scan(
  p_job_id UUID,
  p_success BOOLEAN DEFAULT true,
  p_files_seen INTEGER DEFAULT 0,
  p_files_md5_updated INTEGER DEFAULT 0,
  p_files_removed INTEGER DEFAULT 0,
  p_message TEXT DEFAULT NULL,
  p_prune_missing BOOLEAN DEFAULT true
)
RETURNS TABLE(removed_count INTEGER, status_updates INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  removed_n INTEGER := 0;
  status_n INTEGER := 0;
BEGIN
  IF p_prune_missing THEN
    DELETE FROM local_file
    WHERE last_seen_scan_job_id IS NOT NULL
      AND last_seen_scan_job_id IS DISTINCT FROM p_job_id;
    GET DIAGNOSTICS removed_n = ROW_COUNT;
  END IF;

  SELECT bom_refresh_local_found_statuses() INTO status_n;

  UPDATE bom_scan_jobs
  SET status = CASE WHEN p_success THEN 'succeeded'::bom_scan_job_status ELSE 'failed'::bom_scan_job_status END,
      finished_at = NOW(),
      files_seen = COALESCE(p_files_seen, 0),
      files_md5_updated = COALESCE(p_files_md5_updated, 0),
      files_removed = COALESCE(p_files_removed, 0) + removed_n,
      message = p_message
  WHERE id = p_job_id;

  removed_count := removed_n;
  status_updates := status_n;
  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION bom_finalize_scan(UUID, BOOLEAN, INTEGER, INTEGER, INTEGER, TEXT, BOOLEAN) IS
  '结束扫描：prune 仅针对曾挂过 scan_job 的索引行；last_seen_scan_job_id 为 NULL 的（网页下载直写）保留至磁盘 walk 覆盖';

-- 网页 it 下载完成后写入索引（无 scan job）
CREATE OR REPLACE FUNCTION bom_upsert_local_file_web(
  p_path TEXT,
  p_size_bytes BIGINT,
  p_mtime TIMESTAMPTZ,
  p_md5 TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_path IS NULL OR BTRIM(p_path) = '' THEN
    RAISE EXCEPTION 'p_path cannot be empty';
  END IF;

  INSERT INTO local_file (path, size_bytes, mtime, md5, last_seen_scan_job_id, last_seen_at)
  VALUES (
    BTRIM(p_path),
    COALESCE(p_size_bytes, 0),
    p_mtime,
    CASE
      WHEN p_md5 ~* '^[a-f0-9]{32}$' THEN LOWER(p_md5)
      ELSE NULL
    END,
    NULL,
    NOW()
  )
  ON CONFLICT (path) DO UPDATE
  SET size_bytes = EXCLUDED.size_bytes,
      mtime = EXCLUDED.mtime,
      md5 = CASE
        WHEN EXCLUDED.md5 IS NOT NULL THEN EXCLUDED.md5
        ELSE local_file.md5
      END,
      last_seen_at = EXCLUDED.last_seen_at;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION bom_upsert_local_file_web(TEXT, BIGINT, TIMESTAMPTZ, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION bom_upsert_local_file_web(TEXT, BIGINT, TIMESTAMPTZ, TEXT) TO service_role;
