-- 版本列表「总文件大小」：按行汇总体积（与前端 resolveRowAggregateSizeBytes 一致）

CREATE OR REPLACE FUNCTION public.bom_parse_byte_cell(p_raw text)
RETURNS bigint
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_raw IS NULL OR btrim(p_raw) = '' THEN NULL::bigint
    WHEN regexp_replace(btrim(p_raw), '[,_\s]', '', 'g') ~ '^\d+$' THEN
      regexp_replace(btrim(p_raw), '[,_\s]', '', 'g')::bigint
    WHEN regexp_replace(btrim(p_raw), '[,_\s]', '', 'g') ~ '^\d+\.\d+$'
         AND abs(
           regexp_replace(btrim(p_raw), '[,_\s]', '', 'g')::numeric
           - round(regexp_replace(btrim(p_raw), '[,_\s]', '', 'g')::numeric)
         ) < 0.000001 THEN
      round(regexp_replace(btrim(p_raw), '[,_\s]', '', 'g')::numeric)::bigint
    ELSE NULL::bigint
  END;
$$;

COMMENT ON FUNCTION public.bom_parse_byte_cell(text) IS '解析 BOM 单元格中的字节数（去千分位/空格）';

CREATE OR REPLACE FUNCTION public.bom_extract_byte_size_from_key_list(p_row jsonb, p_keys jsonb)
RETURNS bigint
LANGUAGE plpgsql
STABLE
SET search_path TO public
AS $$
DECLARE
  key_name text;
  sz bigint;
BEGIN
  IF p_row IS NULL OR p_keys IS NULL THEN
    RETURN NULL;
  END IF;

  FOR key_name IN
    SELECT jsonb_array_elements_text(p_keys)
  LOOP
    IF key_name IS NULL OR btrim(key_name) = '' THEN
      CONTINUE;
    END IF;
    sz := public.bom_parse_byte_cell(p_row ->> btrim(key_name));
    IF sz IS NOT NULL AND sz >= 0 THEN
      RETURN sz;
    END IF;
  END LOOP;

  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION public.bom_extract_byte_size_from_key_list(jsonb, jsonb) IS '按 jsonKeyMap 别名列表从 bom_row 取第一个有效字节大小';

CREATE OR REPLACE FUNCTION public.bom_row_aggregate_size_bytes(p_row jsonb, p_status jsonb DEFAULT '{}'::jsonb)
RETURNS bigint
LANGUAGE plpgsql
STABLE
SET search_path TO public
AS $$
DECLARE
  jm jsonb;
  md5l text;
  sz bigint;
  feishu_raw text;
BEGIN
  IF p_row IS NULL THEN
    RETURN NULL;
  END IF;

  md5l := lower(btrim(COALESCE(public.bom_extract_expected_md5(p_row), '')));
  IF md5l ~ '^[a-f0-9]{32}$' THEN
    SELECT lf.size_bytes INTO sz
    FROM public.local_file lf
    WHERE lf.md5 IS NOT NULL
      AND lower(lf.md5) = md5l
    ORDER BY lf.updated_at DESC NULLS LAST
    LIMIT 1;
    IF sz IS NOT NULL AND sz >= 0 THEN
      RETURN sz;
    END IF;
  END IF;

  IF p_status IS NOT NULL AND p_status ? 'feishu_size_bytes' THEN
    feishu_raw := p_status ->> 'feishu_size_bytes';
    sz := public.bom_parse_byte_cell(feishu_raw);
    IF sz IS NOT NULL AND sz >= 0 THEN
      RETURN sz;
    END IF;
  END IF;

  SELECT COALESCE(value -> 'jsonKeyMap', '{}'::jsonb) INTO jm
  FROM public.system_settings
  WHERE key = 'bom_scanner'
  LIMIT 1;

  sz := public.bom_extract_byte_size_from_key_list(
    p_row,
    COALESCE(jm -> 'extFileSizeBytes', '["ext_size_bytes","ext文件大小","extSize","ext大小"]'::jsonb)
  );
  IF sz IS NOT NULL THEN
    RETURN sz;
  END IF;

  sz := public.bom_extract_byte_size_from_key_list(
    p_row,
    COALESCE(jm -> 'fileSizeBytes', '["文件大小","size_bytes","远端大小"]'::jsonb)
  );
  IF sz IS NOT NULL THEN
    RETURN sz;
  END IF;

  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION public.bom_row_aggregate_size_bytes(jsonb, jsonb) IS '单行汇总体积：本地索引 → 飞书 → ext → 远端 BOM 列';

CREATE OR REPLACE FUNCTION public.bom_batch_byte_totals()
RETURNS TABLE(batch_id uuid, total_bytes bigint)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO public
AS $$
  SELECT
    br.batch_id,
    COALESCE(SUM(public.bom_row_aggregate_size_bytes(br.bom_row, br.status)), 0)::bigint AS total_bytes
  FROM public.bom_rows br
  INNER JOIN public.bom_batches b ON b.id = br.batch_id
  WHERE b.user_id = auth.uid()
  GROUP BY br.batch_id;
$$;

COMMENT ON FUNCTION public.bom_batch_byte_totals() IS '当前用户各 BOM 版本行体积合计（用于版本列表）';

GRANT EXECUTE ON FUNCTION public.bom_parse_byte_cell(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.bom_extract_byte_size_from_key_list(jsonb, jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.bom_row_aggregate_size_bytes(jsonb, jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.bom_batch_byte_totals() TO authenticated, service_role;
