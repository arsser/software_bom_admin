-- 修复：bom_sync_bom_row_local_size_from_index 此前对 jsonKeyMap.fileSizeBytes 中
-- 每一个别名列都 jsonb_set，扫描 worker 周期性 RPC 会把已清理的 size_bytes 等再次写回。
-- 新行为：先移除配置中列出的全部别名列，再仅写入首项（规范列名，与迁移 20260419170000 一致）。

CREATE OR REPLACE FUNCTION public.bom_sync_bom_row_local_size_from_index() RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
  AS $$
DECLARE
  jm jsonb;
  keys text[];
  canon_key text;
  k text;
  n integer := 0;
  br_rec record;
  md5l text;
  sz bigint;
  next_bom jsonb;
BEGIN
  SELECT COALESCE(value->'jsonKeyMap', '{}'::jsonb) INTO jm
  FROM public.system_settings
  WHERE key = 'bom_scanner'
  LIMIT 1;

  SELECT COALESCE(array_agg(e ORDER BY ord), ARRAY['文件大小'::text])
  INTO keys
  FROM jsonb_array_elements_text(COALESCE(jm->'fileSizeBytes', '["文件大小"]'::jsonb)) WITH ORDINALITY AS t(e, ord);

  IF keys IS NULL OR cardinality(keys) = 0 THEN
    keys := ARRAY['文件大小'];
  END IF;

  canon_key := NULL;
  FOREACH k IN ARRAY keys LOOP
    IF k IS NOT NULL AND btrim(k) <> '' THEN
      canon_key := btrim(k);
      EXIT;
    END IF;
  END LOOP;

  IF canon_key IS NULL OR canon_key = '' THEN
    canon_key := '文件大小';
  END IF;

  FOR br_rec IN
    SELECT id, bom_row
    FROM public.bom_rows
    WHERE public.bom_extract_expected_md5(bom_row) ~ '^[a-f0-9]{32}$'
  LOOP
    md5l := lower(public.bom_extract_expected_md5(br_rec.bom_row));
    SELECT lf.size_bytes INTO sz
    FROM public.local_file lf
    WHERE lf.md5 IS NOT NULL
      AND lower(lf.md5) = md5l
    ORDER BY lf.updated_at DESC NULLS LAST
    LIMIT 1;

    IF sz IS NULL THEN
      CONTINUE;
    END IF;

    next_bom := br_rec.bom_row;
    FOREACH k IN ARRAY keys LOOP
      IF k IS NOT NULL AND btrim(k) <> '' THEN
        next_bom := next_bom - btrim(k);
      END IF;
    END LOOP;

    next_bom := jsonb_set(next_bom, ARRAY[canon_key], to_jsonb(sz::text), true);

    IF next_bom IS DISTINCT FROM br_rec.bom_row THEN
      UPDATE public.bom_rows SET bom_row = next_bom, updated_at = now() WHERE id = br_rec.id;
      n := n + 1;
    END IF;
  END LOOP;

  RETURN n;
END;
$$;

COMMENT ON FUNCTION public.bom_sync_bom_row_local_size_from_index() IS
  '按期望 MD5 关联 local_file.size_bytes；先移除 jsonKeyMap.fileSizeBytes 所列全部别名列，再仅写回首项（规范列名）。';
