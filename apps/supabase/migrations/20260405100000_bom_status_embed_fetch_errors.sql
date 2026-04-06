-- 将 last_fetch_error / ext_fetch_error 并入 status JSONB（local_fetch_error / ext_fetch_error），与 local、ext 状态同存一处

-- 1) 迁入已有列数据（需已执行 20260404190000 添加 ext_fetch_error；last_fetch_error 来自更早迁移）
UPDATE bom_rows br
SET status =
  COALESCE(br.status, '{}'::jsonb)
  || CASE
       WHEN br.last_fetch_error IS NOT NULL AND BTRIM(br.last_fetch_error) <> ''
       THEN jsonb_build_object('local_fetch_error', BTRIM(br.last_fetch_error))
       ELSE '{}'::jsonb
     END
  || CASE
       WHEN br.ext_fetch_error IS NOT NULL AND BTRIM(br.ext_fetch_error) <> ''
       THEN jsonb_build_object('ext_fetch_error', BTRIM(br.ext_fetch_error))
       ELSE '{}'::jsonb
     END;

-- 2) 刷新函数：用 status.local_fetch_error 替代列 last_fetch_error
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
      CASE
        WHEN sub.new_local IN ('verified_ok', 'verified_fail', 'await_manual_download')
        THEN br.status - 'local_fetch_error'
        ELSE br.status
      END,
      '{local}',
      to_jsonb(
        CASE
          WHEN sub.new_local = 'pending'
               AND NULLIF(BTRIM(COALESCE(br.status->>'local_fetch_error', '')), '') IS NOT NULL
            THEN 'error'
          ELSE sub.new_local
        END
      ),
      true
    )
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
          WHEN sub.new_local = 'pending'
               AND NULLIF(BTRIM(COALESCE(br.status->>'local_fetch_error', '')), '') IS NOT NULL
            THEN 'error'
          ELSE sub.new_local
        END
      )
      OR NULLIF(BTRIM(COALESCE(br.status->>'local_fetch_error', '')), '') IS DISTINCT FROM (
        CASE
          WHEN sub.new_local IN ('verified_ok', 'verified_fail', 'await_manual_download') THEN NULL::text
          ELSE NULLIF(BTRIM(COALESCE(br.status->>'local_fetch_error', '')), '')
        END
      )
    );

  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

COMMENT ON FUNCTION bom_refresh_local_found_statuses() IS '扫描结束后仅更新 status.local；不修改 ext=synced_or_skipped；local_fetch_error 在本地终态时清除';

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
      CASE
        WHEN sub.new_local IN ('verified_ok', 'verified_fail', 'await_manual_download')
        THEN br.status - 'local_fetch_error'
        ELSE br.status
      END,
      '{local}',
      to_jsonb(
        CASE
          WHEN sub.new_local = 'pending'
               AND NULLIF(BTRIM(COALESCE(br.status->>'local_fetch_error', '')), '') IS NOT NULL
            THEN 'error'
          ELSE sub.new_local
        END
      ),
      true
    )
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
          WHEN sub.new_local = 'pending'
               AND NULLIF(BTRIM(COALESCE(br.status->>'local_fetch_error', '')), '') IS NOT NULL
            THEN 'error'
          ELSE sub.new_local
        END
      )
      OR NULLIF(BTRIM(COALESCE(br.status->>'local_fetch_error', '')), '') IS DISTINCT FROM (
        CASE
          WHEN sub.new_local IN ('verified_ok', 'verified_fail', 'await_manual_download') THEN NULL::text
          ELSE NULLIF(BTRIM(COALESCE(br.status->>'local_fetch_error', '')), '')
        END
      )
    );

  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

COMMENT ON FUNCTION bom_refresh_local_found_statuses_for_batch(UUID) IS
  '按 local_file 重算该批次 status.local（跳过 ext=synced_or_skipped）；local_fetch_error 在本地终态时清除';

-- 3) 删除独立列
ALTER TABLE bom_rows DROP COLUMN IF EXISTS last_fetch_error;
ALTER TABLE bom_rows DROP COLUMN IF EXISTS ext_fetch_error;

COMMENT ON COLUMN bom_rows.status IS
  'JSONB：local、ext 为枚举状态；可选 local_fetch_error / ext_fetch_error 为 it 与 ext 链路说明文本';
