-- ============================================
-- 移除产品分类（简化：仅保留 products）
-- ============================================

-- 先删除依赖于分类的列/约束
ALTER TABLE products
  DROP COLUMN IF EXISTS category_id;

DROP INDEX IF EXISTS idx_products_category;

-- 删除分类表相关触发器/策略/表
DROP TRIGGER IF EXISTS update_product_categories_updated_at ON product_categories;

ALTER TABLE IF EXISTS product_categories DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users manage own product categories" ON product_categories;
DROP POLICY IF EXISTS "Service role full product categories" ON product_categories;

DROP TABLE IF EXISTS product_categories;

