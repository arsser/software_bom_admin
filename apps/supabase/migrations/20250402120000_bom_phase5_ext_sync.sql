-- ============================================
-- BOM Lite 阶段 5：ext-Artifactory 同步任务（checksum 查重 → Copy 或本地上传）
-- ============================================

CREATE OR REPLACE FUNCTION bom_extract_ext_url(p_row JSONB)
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
    SELECT jsonb_array_elements_text(COALESCE(cfg->'jsonKeyMap'->'extUrl', '["ext_url","extUrl","转存地址"]'::jsonb))
  LOOP
    v := NULLIF(BTRIM(p_row ->> key_name), '');
    IF v IS NOT NULL THEN
      RETURN v;
    END IF;
  END LOOP;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE;

COMMENT ON FUNCTION bom_extract_ext_url(JSONB) IS '按 bom_scanner.jsonKeyMap.extUrl 从 BOM 行提取 ext 转存 URI';

CREATE TABLE IF NOT EXISTS bom_ext_sync_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id UUID NOT NULL REFERENCES bom_batches(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  row_ids UUID[] NOT NULL,
  status bom_download_job_status NOT NULL DEFAULT 'queued',
  progress_current INTEGER NOT NULL DEFAULT 0,
  progress_total INTEGER NOT NULL DEFAULT 0,
  last_message TEXT,
  trigger_source TEXT NOT NULL DEFAULT 'web',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  heartbeat_at TIMESTAMPTZ,
  running_row_id UUID REFERENCES bom_rows(id) ON DELETE SET NULL
);

COMMENT ON TABLE bom_ext_sync_jobs IS '网页触发的 ext-Artifactory 同步任务（worker 消费）：校验通过后 checksum 查重、Copy 或上传';

CREATE INDEX IF NOT EXISTS idx_bom_ext_sync_jobs_batch ON bom_ext_sync_jobs(batch_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bom_ext_sync_jobs_status ON bom_ext_sync_jobs(status);

DROP TRIGGER IF EXISTS update_bom_ext_sync_jobs_updated_at ON bom_ext_sync_jobs;
CREATE TRIGGER update_bom_ext_sync_jobs_updated_at
  BEFORE UPDATE ON bom_ext_sync_jobs
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE bom_ext_sync_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users read own batch ext sync jobs" ON bom_ext_sync_jobs;
CREATE POLICY "Users read own batch ext sync jobs"
  ON bom_ext_sync_jobs FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM bom_batches b
      WHERE b.id = bom_ext_sync_jobs.batch_id AND b.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Service role full bom_ext_sync_jobs" ON bom_ext_sync_jobs;
CREATE POLICY "Service role full bom_ext_sync_jobs"
  ON bom_ext_sync_jobs FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

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
      WHERE br.status = 'verified_ok'::bom_row_status
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
      AND br.status = 'verified_ok'::bom_row_status
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

REVOKE ALL ON FUNCTION bom_request_ext_sync(UUID, UUID[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION bom_request_ext_sync(UUID, UUID[]) TO authenticated;

COMMENT ON FUNCTION bom_request_ext_sync(UUID, UUID[]) IS '网页触发 ext 同步：p_row_ids 为空则当前批次全部「校验通过且尚无 ext_url」行';

CREATE OR REPLACE FUNCTION bom_claim_ext_sync_job()
RETURNS TABLE(
  id UUID,
  batch_id UUID,
  row_ids UUID[],
  progress_total INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  picked UUID;
BEGIN
  SELECT j2.id
  INTO picked
  FROM bom_ext_sync_jobs j2
  WHERE j2.status = 'queued'::bom_download_job_status
  ORDER BY j2.created_at ASC
  LIMIT 1
  FOR UPDATE SKIP LOCKED;

  IF picked IS NULL THEN
    RETURN;
  END IF;

  UPDATE bom_ext_sync_jobs j
  SET status = 'running'::bom_download_job_status,
      updated_at = NOW(),
      started_at = COALESCE(j.started_at, NOW()),
      heartbeat_at = NOW()
  WHERE j.id = picked;

  RETURN QUERY
  SELECT j.id, j.batch_id, j.row_ids, j.progress_total
  FROM bom_ext_sync_jobs j
  WHERE j.id = picked;
END;
$$;

REVOKE ALL ON FUNCTION bom_claim_ext_sync_job() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION bom_claim_ext_sync_job() FROM authenticated;
GRANT EXECUTE ON FUNCTION bom_claim_ext_sync_job() TO service_role;

CREATE OR REPLACE FUNCTION bom_cancel_ext_sync_job(p_job_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user UUID := auth.uid();
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  UPDATE bom_ext_sync_jobs j
  SET status = 'cancelled'::bom_download_job_status,
      finished_at = NOW(),
      last_message = '用户取消排队',
      updated_at = NOW(),
      running_row_id = NULL
  WHERE j.id = p_job_id
    AND j.status = 'queued'::bom_download_job_status
    AND EXISTS (
      SELECT 1 FROM bom_batches b
      WHERE b.id = j.batch_id AND b.user_id = v_user
    );

  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION bom_cancel_ext_sync_job(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION bom_cancel_ext_sync_job(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION bom_fail_stale_ext_sync_jobs(p_stale_seconds INTEGER DEFAULT 900)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  n INTEGER := 0;
  v_cutoff TIMESTAMPTZ;
BEGIN
  IF p_stale_seconds IS NULL OR p_stale_seconds < 60 THEN
    p_stale_seconds := 900;
  END IF;
  v_cutoff := NOW() - (p_stale_seconds::text || ' seconds')::interval;

  UPDATE bom_ext_sync_jobs j
  SET status = 'failed'::bom_download_job_status,
      finished_at = NOW(),
      last_message = 'worker 心跳超时（可能进程崩溃或网络中断）',
      updated_at = NOW(),
      running_row_id = NULL
  WHERE j.status = 'running'::bom_download_job_status
    AND COALESCE(j.heartbeat_at, j.updated_at, j.started_at) < v_cutoff;

  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

REVOKE ALL ON FUNCTION bom_fail_stale_ext_sync_jobs(INTEGER) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION bom_fail_stale_ext_sync_jobs(INTEGER) FROM authenticated;
GRANT EXECUTE ON FUNCTION bom_fail_stale_ext_sync_jobs(INTEGER) TO service_role;

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
      AND br.status = 'verified_ok'::bom_row_status
      AND (
        bom_extract_ext_url(br.bom_row) IS NULL
        OR BTRIM(bom_extract_ext_url(br.bom_row)) = ''
      )
  );
$$;

REVOKE ALL ON FUNCTION bom_row_still_eligible_for_ext_sync(UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION bom_row_still_eligible_for_ext_sync(UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION bom_row_still_eligible_for_ext_sync(UUID) TO service_role;
