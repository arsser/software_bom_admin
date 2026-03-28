-- ============================================
-- BOM Lite 阶段 2：本地目录扫描任务与索引收敛
-- ============================================

DO $$ BEGIN
  CREATE TYPE bom_scan_job_status AS ENUM (
    'queued',
    'running',
    'succeeded',
    'failed'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS bom_scan_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  status bom_scan_job_status NOT NULL DEFAULT 'queued',
  trigger_source TEXT NOT NULL DEFAULT 'manual',
  message TEXT,
  files_seen INTEGER NOT NULL DEFAULT 0,
  files_md5_updated INTEGER NOT NULL DEFAULT 0,
  files_removed INTEGER NOT NULL DEFAULT 0,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE bom_scan_jobs IS '本地目录扫描任务（可手动触发或定时触发）';
COMMENT ON COLUMN bom_scan_jobs.trigger_source IS '触发来源，如 manual/scheduler/worker';

CREATE INDEX IF NOT EXISTS idx_bom_scan_jobs_requested_at ON bom_scan_jobs(requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_bom_scan_jobs_status ON bom_scan_jobs(status);

ALTER TABLE local_file
  ADD COLUMN IF NOT EXISTS last_seen_scan_job_id UUID REFERENCES bom_scan_jobs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_local_file_last_seen_scan_job ON local_file(last_seen_scan_job_id);

DROP TRIGGER IF EXISTS update_bom_scan_jobs_updated_at ON bom_scan_jobs;
CREATE TRIGGER update_bom_scan_jobs_updated_at
  BEFORE UPDATE ON bom_scan_jobs
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE bom_scan_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated can read bom_scan_jobs" ON bom_scan_jobs;
CREATE POLICY "Authenticated can read bom_scan_jobs"
  ON bom_scan_jobs FOR SELECT
  USING (auth.role() IN ('authenticated', 'service_role'));

DROP POLICY IF EXISTS "Authenticated can insert bom_scan_jobs" ON bom_scan_jobs;
CREATE POLICY "Authenticated can insert bom_scan_jobs"
  ON bom_scan_jobs FOR INSERT
  WITH CHECK (auth.role() IN ('authenticated', 'service_role'));

DROP POLICY IF EXISTS "Service role full bom_scan_jobs" ON bom_scan_jobs;
CREATE POLICY "Service role full bom_scan_jobs"
  ON bom_scan_jobs FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE OR REPLACE FUNCTION bom_extract_expected_md5(p_row JSONB)
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
    SELECT jsonb_array_elements_text(COALESCE(cfg->'jsonKeyMap'->'expectedMd5', '[]'::jsonb))
  LOOP
    v := NULLIF(BTRIM(p_row ->> key_name), '');
    IF v IS NOT NULL THEN
      RETURN LOWER(v);
    END IF;
  END LOOP;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE;

COMMENT ON FUNCTION bom_extract_expected_md5(JSONB) IS '按 bom_scanner.jsonKeyMap.expectedMd5 从 BOM 行提取期望 MD5';

CREATE OR REPLACE FUNCTION bom_refresh_local_found_statuses()
RETURNS INTEGER AS $$
DECLARE
  affected_count INTEGER := 0;
  n INTEGER;
BEGIN
  WITH matched AS (
    SELECT br.id
    FROM bom_rows br
    JOIN local_file lf
      ON lf.md5 IS NOT NULL
     AND lf.md5 ~ '^[a-f0-9]{32}$'
     AND lf.md5 = bom_extract_expected_md5(br.bom_row)
    WHERE br.status IN ('pending', 'await_manual_download', 'error')
  )
  UPDATE bom_rows br
  SET status = 'local_found'
  FROM matched m
  WHERE br.id = m.id;
  GET DIAGNOSTICS n = ROW_COUNT;
  affected_count := affected_count + n;

  WITH unmatched AS (
    SELECT br.id
    FROM bom_rows br
    WHERE br.status = 'local_found'
      AND (
        bom_extract_expected_md5(br.bom_row) IS NULL
        OR NOT EXISTS (
          SELECT 1
          FROM local_file lf
          WHERE lf.md5 IS NOT NULL
            AND lf.md5 = bom_extract_expected_md5(br.bom_row)
        )
      )
  )
  UPDATE bom_rows br
  SET status = 'pending'
  FROM unmatched u
  WHERE br.id = u.id;
  GET DIAGNOSTICS n = ROW_COUNT;
  affected_count := affected_count + n;

  RETURN affected_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION bom_refresh_local_found_statuses() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION bom_request_scan(p_trigger_source TEXT DEFAULT 'manual')
RETURNS UUID AS $$
DECLARE
  v_id UUID;
BEGIN
  INSERT INTO bom_scan_jobs (status, trigger_source, requested_at)
  VALUES ('queued', COALESCE(NULLIF(BTRIM(p_trigger_source), ''), 'manual'), NOW())
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION bom_request_scan(TEXT) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION bom_mark_scan_started(p_job_id UUID, p_message TEXT DEFAULT NULL)
RETURNS BOOLEAN AS $$
BEGIN
  UPDATE bom_scan_jobs
  SET status = 'running',
      started_at = NOW(),
      message = p_message
  WHERE id = p_job_id;

  RETURN FOUND;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION bom_mark_scan_started(UUID, TEXT) TO service_role;

CREATE OR REPLACE FUNCTION bom_upsert_local_file(
  p_job_id UUID,
  p_path TEXT,
  p_size_bytes BIGINT,
  p_mtime TIMESTAMPTZ,
  p_md5 TEXT
)
RETURNS BOOLEAN AS $$
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
    p_job_id,
    NOW()
  )
  ON CONFLICT (path) DO UPDATE
  SET size_bytes = EXCLUDED.size_bytes,
      mtime = EXCLUDED.mtime,
      md5 = CASE
        WHEN EXCLUDED.md5 IS NOT NULL THEN EXCLUDED.md5
        ELSE local_file.md5
      END,
      last_seen_scan_job_id = EXCLUDED.last_seen_scan_job_id,
      last_seen_at = EXCLUDED.last_seen_at;

  RETURN true;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION bom_upsert_local_file(UUID, TEXT, BIGINT, TIMESTAMPTZ, TEXT) TO service_role;

CREATE OR REPLACE FUNCTION bom_finalize_scan(
  p_job_id UUID,
  p_success BOOLEAN DEFAULT true,
  p_files_seen INTEGER DEFAULT 0,
  p_files_md5_updated INTEGER DEFAULT 0,
  p_files_removed INTEGER DEFAULT 0,
  p_message TEXT DEFAULT NULL,
  p_prune_missing BOOLEAN DEFAULT true
)
RETURNS TABLE(removed_count INTEGER, status_updates INTEGER) AS $$
DECLARE
  removed_n INTEGER := 0;
  status_n INTEGER := 0;
BEGIN
  IF p_prune_missing THEN
    DELETE FROM local_file
    WHERE last_seen_scan_job_id IS DISTINCT FROM p_job_id;
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
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION bom_finalize_scan(UUID, BOOLEAN, INTEGER, INTEGER, INTEGER, TEXT, BOOLEAN) TO service_role;
