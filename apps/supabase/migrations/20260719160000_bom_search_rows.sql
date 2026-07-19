-- 全局 BOM 行搜索：在指定产品/版本范围内，对 bom_row JSONB 全文 ILIKE

CREATE OR REPLACE FUNCTION public.bom_search_rows(
  p_query text,
  p_product_id uuid DEFAULT NULL,
  p_batch_ids uuid[] DEFAULT NULL,
  p_limit integer DEFAULT 100,
  p_offset integer DEFAULT 0
)
RETURNS TABLE(
  row_id uuid,
  batch_id uuid,
  batch_name text,
  product_id uuid,
  product_name text,
  sort_order integer,
  bom_row jsonb,
  status jsonb,
  created_at timestamp with time zone
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO public
AS $$
  WITH q AS (
    SELECT
      trim(COALESCE(p_query, '')) AS raw,
      -- ILIKE 通配符转义
      replace(
        replace(
          replace(trim(COALESCE(p_query, '')), E'\\', E'\\\\'),
          '%',
          E'\\%'
        ),
        '_',
        E'\\_'
      ) AS escaped
  )
  SELECT
    br.id AS row_id,
    b.id AS batch_id,
    b.name::text AS batch_name,
    p.id AS product_id,
    p.name::text AS product_name,
    br.sort_order,
    br.bom_row,
    br.status,
    br.created_at
  FROM public.bom_rows br
  INNER JOIN public.bom_batches b ON b.id = br.batch_id
  INNER JOIN public.products p ON p.id = b.product_id
  CROSS JOIN q
  WHERE b.user_id = auth.uid()
    AND char_length(q.raw) >= 2
    AND (p_product_id IS NULL OR b.product_id = p_product_id)
    AND (
      p_batch_ids IS NULL
      OR cardinality(p_batch_ids) = 0
      OR b.id = ANY (p_batch_ids)
    )
    AND br.bom_row::text ILIKE ('%' || q.escaped || '%') ESCAPE E'\\'
  ORDER BY b.created_at DESC, br.sort_order ASC, br.id ASC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500)
  OFFSET GREATEST(COALESCE(p_offset, 0), 0);
$$;

COMMENT ON FUNCTION public.bom_search_rows(text, uuid, uuid[], integer, integer) IS
  '当前用户：按产品/版本过滤，在 bom_row JSONB 文本中 ILIKE 搜索（关键词至少 2 字符）';

GRANT EXECUTE ON FUNCTION public.bom_search_rows(text, uuid, uuid[], integer, integer)
  TO authenticated, service_role;
