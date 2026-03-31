-- ============================================
-- BOM：网页触发 it 拉取任务（队列 + 进度，由 worker 执行）
-- ============================================

DO $$ BEGIN
  CREATE TYPE bom_download_job_status AS ENUM (
    'queued',
    'running',
    'succeeded',
    'failed',
    'cancelled'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS bom_download_jobs (
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
  finished_at TIMESTAMPTZ
);

COMMENT ON TABLE bom_download_jobs IS '网页或后台触发的 it-Artifactory 批量拉取任务（worker 消费）';

CREATE INDEX IF NOT EXISTS idx_bom_download_jobs_batch ON bom_download_jobs(batch_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bom_download_jobs_status ON bom_download_jobs(status);

DROP TRIGGER IF EXISTS update_bom_download_jobs_updated_at ON bom_download_jobs;
CREATE TRIGGER update_bom_download_jobs_updated_at
  BEFORE UPDATE ON bom_download_jobs
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE bom_download_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users read own batch download jobs" ON bom_download_jobs;
CREATE POLICY "Users read own batch download jobs"
  ON bom_download_jobs FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM bom_batches b
      WHERE b.id = bom_download_jobs.batch_id AND b.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Service role full bom_download_jobs" ON bom_download_jobs;
CREATE POLICY "Service role full bom_download_jobs"
  ON bom_download_jobs FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- worker：按 id 列表取下载 URL（顺序由调用方保证）
CREATE OR REPLACE FUNCTION bom_row_download_targets(p_ids UUID[])
RETURNS TABLE(id UUID, download_url TEXT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT br.id, bom_extract_download_url(br.bom_row) AS download_url
  FROM bom_rows br
  WHERE br.id = ANY(p_ids);
$$;

REVOKE ALL ON FUNCTION bom_row_download_targets(UUID[]) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION bom_row_download_targets(UUID[]) FROM authenticated;
GRANT EXECUTE ON FUNCTION bom_row_download_targets(UUID[]) TO service_role;

-- 与 bom_rows_for_it_download 单行语义一致（用于 worker 跳过已不需要的行）
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
      AND br.status IN ('pending', 'error')
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

REVOKE ALL ON FUNCTION bom_row_still_eligible_for_it_download(UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION bom_row_still_eligible_for_it_download(UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION bom_row_still_eligible_for_it_download(UUID) TO service_role;

-- 认证用户创建任务（仅 eligible 行）
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
      WHERE br.status IN ('pending', 'error')
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
      AND br.status IN ('pending', 'error')
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

REVOKE ALL ON FUNCTION bom_request_download(UUID, UUID[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION bom_request_download(UUID, UUID[]) TO authenticated;

COMMENT ON FUNCTION bom_request_download(UUID, UUID[]) IS '网页触发 it 拉取：p_row_ids 为空则当前批次全部 eligible 行';

-- worker 抢占一条排队任务
CREATE OR REPLACE FUNCTION bom_claim_download_job()
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
BEGIN
  RETURN QUERY
  UPDATE bom_download_jobs j
  SET status = 'running'::bom_download_job_status,
      updated_at = NOW()
  WHERE j.id = (
    SELECT j2.id
    FROM bom_download_jobs j2
    WHERE j2.status = 'queued'::bom_download_job_status
    ORDER BY j2.created_at ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  )
  RETURNING j.id, j.batch_id, j.row_ids, j.progress_total;
END;
$$;

REVOKE ALL ON FUNCTION bom_claim_download_job() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION bom_claim_download_job() FROM authenticated;
GRANT EXECUTE ON FUNCTION bom_claim_download_job() TO service_role;
