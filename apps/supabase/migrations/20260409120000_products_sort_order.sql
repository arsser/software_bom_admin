-- 产品排序：支持在 BOM 管理页上移/下移
ALTER TABLE public.products
ADD COLUMN IF NOT EXISTS sort_order integer;

-- 为已有数据按创建时间补齐排序号（每个用户内从 0 递增）
WITH ranked AS (
  SELECT
    id,
    user_id,
    row_number() OVER (PARTITION BY user_id ORDER BY created_at ASC, id ASC) - 1 AS rn
  FROM public.products
)
UPDATE public.products p
SET sort_order = r.rn
FROM ranked r
WHERE p.id = r.id
  AND (p.sort_order IS NULL OR p.sort_order < 0);

UPDATE public.products
SET sort_order = 0
WHERE sort_order IS NULL;

ALTER TABLE public.products
ALTER COLUMN sort_order SET DEFAULT 0;

ALTER TABLE public.products
ALTER COLUMN sort_order SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_products_user_sort
ON public.products (user_id, sort_order, created_at);

