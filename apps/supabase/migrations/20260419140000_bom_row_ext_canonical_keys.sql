-- 将 bom_rows.bom_row 中 ext 转存链接、ext 文件大小的多别名列收敛为规范键 ext_url、ext_size_bytes
-- （与 apps/supabase/functions/bom-ext-artifactory-checkcopy 写回一致；读侧仍按 bom_scanner.jsonKeyMap 解析别名列名）

CREATE OR REPLACE FUNCTION public.bom_normalize_bom_row_ext_aliases(p_row jsonb)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SET search_path TO 'public'
AS $fn$
DECLARE
  cfg jsonb;
  url_pick text[];
  sz_pick text[];
  strip_keys text[];
  chosen_url text;
  chosen_sz text;
  k text;
  v text;
  out_json jsonb := '{}'::jsonb;
  r record;
BEGIN
  IF p_row IS NULL OR jsonb_typeof(p_row) <> 'object' THEN
    RETURN COALESCE(p_row, '{}'::jsonb);
  END IF;

  SELECT value INTO cfg FROM public.system_settings WHERE key = 'bom_scanner' LIMIT 1;
  cfg := COALESCE(cfg, '{}'::jsonb);

  url_pick := ARRAY(
    SELECT t.x
    FROM jsonb_array_elements_text(COALESCE(cfg #> '{jsonKeyMap,extUrl}', '[]'::jsonb)) AS t(x)
  );
  IF cardinality(url_pick) = 0 THEN
    url_pick := ARRAY['ext_url', 'extUrl', '转存地址']::text[];
  END IF;

  sz_pick := ARRAY(
    SELECT t.x
    FROM jsonb_array_elements_text(COALESCE(cfg #> '{jsonKeyMap,extFileSizeBytes}', '[]'::jsonb)) AS t(x)
  );
  IF cardinality(sz_pick) = 0 THEN
    sz_pick := ARRAY['ext_size_bytes', 'ext文件大小', 'extSize', 'ext大小']::text[];
  END IF;

  strip_keys := ARRAY(
    SELECT DISTINCT u
    FROM unnest(
      url_pick || sz_pick || ARRAY[
        'ext_url', 'extUrl', '转存地址',
        'ext_size_bytes', 'ext文件大小', 'extSize', 'ext大小'
      ]::text[]
    ) AS u
    WHERE u IS NOT NULL AND length(trim(u)) > 0
  );

  chosen_url := NULL;
  FOREACH k IN ARRAY url_pick LOOP
    IF length(trim(k)) = 0 THEN
      CONTINUE;
    END IF;
    IF p_row ? k THEN
      v := trim(both from p_row ->> k);
      IF length(v) > 0 THEN
        chosen_url := v;
        EXIT;
      END IF;
    END IF;
  END LOOP;

  chosen_sz := NULL;
  FOREACH k IN ARRAY sz_pick LOOP
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

  IF chosen_url IS NOT NULL THEN
    out_json := out_json || jsonb_build_object('ext_url', to_jsonb(chosen_url));
  END IF;
  IF chosen_sz IS NOT NULL THEN
    out_json := out_json || jsonb_build_object('ext_size_bytes', to_jsonb(chosen_sz));
  END IF;

  RETURN out_json;
END;
$fn$;

COMMENT ON FUNCTION public.bom_normalize_bom_row_ext_aliases(jsonb) IS
  '将 bom_row JSON 中 ext 链接/大小别名列合并为 ext_url、ext_size_bytes；供一次性迁移使用。';

UPDATE public.bom_rows
SET
  bom_row = public.bom_normalize_bom_row_ext_aliases(bom_row),
  updated_at = now()
WHERE bom_row IS NOT NULL;

DROP FUNCTION public.bom_normalize_bom_row_ext_aliases(jsonb);
