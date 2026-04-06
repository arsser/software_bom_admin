-- 扫描结束后由 worker 调用：把 local_file 中按 MD5 命中的 size_bytes 写回 bom_row 的 fileSizeBytes 别名列（读 system_settings.bom_scanner.jsonKeyMap）

CREATE OR REPLACE FUNCTION bom_sync_bom_row_local_size_from_index()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  jm jsonb;
  keys text[];
  k text;
  n INTEGER := 0;
  br_rec RECORD;
  md5l TEXT;
  sz BIGINT;
  next_bom jsonb;
BEGIN
  SELECT COALESCE(value->'jsonKeyMap', '{}'::jsonb) INTO jm
  FROM system_settings
  WHERE key = 'bom_scanner'
  LIMIT 1;

  SELECT COALESCE(array_agg(e ORDER BY ord), ARRAY['文件大小'::text])
  INTO keys
  FROM jsonb_array_elements_text(COALESCE(jm->'fileSizeBytes', '["文件大小"]'::jsonb)) WITH ORDINALITY AS t(e, ord);

  IF keys IS NULL OR cardinality(keys) = 0 THEN
    keys := ARRAY['文件大小'];
  END IF;

  FOR br_rec IN
    SELECT id, bom_row
    FROM bom_rows
    WHERE bom_extract_expected_md5(bom_row) ~ '^[a-f0-9]{32}$'
  LOOP
    md5l := lower(bom_extract_expected_md5(br_rec.bom_row));
    SELECT lf.size_bytes INTO sz
    FROM local_file lf
    WHERE lf.md5 IS NOT NULL
      AND lower(lf.md5) = md5l
    ORDER BY lf.updated_at DESC NULLS LAST
    LIMIT 1;

    IF sz IS NULL THEN
      CONTINUE;
    END IF;

    next_bom := br_rec.bom_row;
    FOREACH k IN ARRAY keys LOOP
      IF k IS NULL OR BTRIM(k) = '' THEN
        CONTINUE;
      END IF;
      next_bom := jsonb_set(next_bom, ARRAY[k], to_jsonb(sz::text), true);
    END LOOP;

    IF next_bom IS DISTINCT FROM br_rec.bom_row THEN
      UPDATE bom_rows SET bom_row = next_bom WHERE id = br_rec.id;
      n := n + 1;
    END IF;
  END LOOP;

  RETURN n;
END;
$$;

COMMENT ON FUNCTION bom_sync_bom_row_local_size_from_index() IS
  '按期望 MD5 关联 local_file.size_bytes，写回 bom_row 中 jsonKeyMap.fileSizeBytes 所列列名';

REVOKE ALL ON FUNCTION bom_sync_bom_row_local_size_from_index() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION bom_sync_bom_row_local_size_from_index() TO service_role;
