-- 将 bom_rows.bom_row 中 fileSizeBytes 别名列（文件大小 / size_bytes / 远端大小）收敛为规范列：
-- 规范名 = bom_scanner.jsonKeyMap.fileSizeBytes 数组的首元素；缺省或未配置时为「文件大小」
-- （与 apps/web/src/lib/bomScannerSettings.ts 中 defaultJsonKeyMap.fileSizeBytes 顺序一致）

CREATE OR REPLACE FUNCTION public.bom_normalize_bom_row_file_size_keys(p_row jsonb)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SET search_path TO 'public'
AS $fn$
DECLARE
  cfg jsonb;
  size_pick text[];
  strip_keys text[];
  canon_key text;
  chosen_sz text;
  k text;
  v text;
  out_json jsonb := '{}'::jsonb;
  r record;
  default_pick constant text[] := ARRAY['文件大小', 'size_bytes', '远端大小']::text[];
BEGIN
  IF p_row IS NULL OR jsonb_typeof(p_row) <> 'object' THEN
    RETURN COALESCE(p_row, '{}'::jsonb);
  END IF;

  SELECT value INTO cfg FROM public.system_settings WHERE key = 'bom_scanner' LIMIT 1;
  cfg := COALESCE(cfg, '{}'::jsonb);

  size_pick := ARRAY(
    SELECT t.x
    FROM jsonb_array_elements_text(COALESCE(cfg #> '{jsonKeyMap,fileSizeBytes}', '[]'::jsonb)) AS t(x)
  );
  IF cardinality(size_pick) = 0 THEN
    size_pick := default_pick;
  END IF;

  canon_key := trim(both from size_pick[1]);
  IF length(canon_key) = 0 THEN
    canon_key := '文件大小';
  END IF;

  strip_keys := ARRAY(
    SELECT DISTINCT u
    FROM unnest(size_pick || default_pick) AS u
    WHERE u IS NOT NULL AND length(trim(u)) > 0
  );

  chosen_sz := NULL;
  FOREACH k IN ARRAY size_pick LOOP
    IF length(trim(k)) = 0 THEN
      CONTINUE;
    END IF;
    IF p_row ? k THEN
      v := trim(both from p_row ->> k);
      IF length(v) > 0 THEN
        chosen_sz := v;
        EXIT;
      END IF;
    END IF;
  END LOOP;

  FOR r IN
    SELECT key, value
    FROM jsonb_each(p_row)
  LOOP
    IF r.key = ANY (strip_keys) THEN
      CONTINUE;
    END IF;
    out_json := out_json || jsonb_build_object(r.key, r.value);
  END LOOP;

  IF chosen_sz IS NOT NULL THEN
    out_json := out_json || jsonb_build_object(canon_key, to_jsonb(chosen_sz));
  END IF;

  RETURN out_json;
END;
$fn$;

COMMENT ON FUNCTION public.bom_normalize_bom_row_file_size_keys(jsonb) IS
  '将 bom_row 中 fileSizeBytes 多别名列合并为 jsonKeyMap.fileSizeBytes[0]（默认「文件大小」）。';

UPDATE public.bom_rows
SET
  bom_row = public.bom_normalize_bom_row_file_size_keys(bom_row),
  updated_at = now()
WHERE bom_row IS NOT NULL;

DROP FUNCTION public.bom_normalize_bom_row_file_size_keys(jsonb);
