-- ============================================
-- BOM Lite 阶段 1：产品分类/产品，并关联 BOM 批次
-- ============================================

-- 产品分类
CREATE TABLE IF NOT EXISTS product_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, name)
);

COMMENT ON TABLE product_categories IS '产品分类（用户维度）';
COMMENT ON COLUMN product_categories.name IS '分类名称';

CREATE INDEX IF NOT EXISTS idx_product_categories_user ON product_categories(user_id);

DROP TRIGGER IF EXISTS update_product_categories_updated_at ON product_categories;
CREATE TRIGGER update_product_categories_updated_at
  BEFORE UPDATE ON product_categories
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE product_categories ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users manage own product categories" ON product_categories;
CREATE POLICY "Users manage own product categories"
  ON product_categories FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Service role full product categories" ON product_categories;
CREATE POLICY "Service role full product categories"
  ON product_categories FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- 产品
CREATE TABLE IF NOT EXISTS products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  category_id UUID REFERENCES product_categories(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, name)
);

COMMENT ON TABLE products IS '产品（用户维度）';
COMMENT ON COLUMN products.category_id IS '所属分类，可为空';
COMMENT ON COLUMN products.name IS '产品名称';

CREATE INDEX IF NOT EXISTS idx_products_user ON products(user_id);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);

DROP TRIGGER IF EXISTS update_products_updated_at ON products;
CREATE TRIGGER update_products_updated_at
  BEFORE UPDATE ON products
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE products ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users manage own products" ON products;
CREATE POLICY "Users manage own products"
  ON products FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Service role full products" ON products;
CREATE POLICY "Service role full products"
  ON products FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- bom_batches 关联产品：创建 BOM 批次必须选择产品
ALTER TABLE bom_batches
  ADD COLUMN IF NOT EXISTS product_id UUID REFERENCES products(id) ON DELETE RESTRICT;

-- 先给历史数据一个兜底产品（避免 NOT NULL 失败）
DO $$
DECLARE
  u RECORD;
  c_id UUID;
  p_id UUID;
BEGIN
  FOR u IN SELECT DISTINCT user_id FROM bom_batches LOOP
    -- 分类：默认
    INSERT INTO product_categories (user_id, name)
    VALUES (u.user_id, '默认')
    ON CONFLICT (user_id, name) DO UPDATE SET name = EXCLUDED.name
    RETURNING id INTO c_id;

    IF c_id IS NULL THEN
      SELECT id INTO c_id FROM product_categories WHERE user_id = u.user_id AND name = '默认' LIMIT 1;
    END IF;

    -- 产品：未分类产品
    INSERT INTO products (user_id, category_id, name)
    VALUES (u.user_id, c_id, '未分类产品')
    ON CONFLICT (user_id, name) DO UPDATE SET name = EXCLUDED.name
    RETURNING id INTO p_id;

    IF p_id IS NULL THEN
      SELECT id INTO p_id FROM products WHERE user_id = u.user_id AND name = '未分类产品' LIMIT 1;
    END IF;

    UPDATE bom_batches SET product_id = p_id WHERE user_id = u.user_id AND product_id IS NULL;
  END LOOP;
END $$;

ALTER TABLE bom_batches
  ALTER COLUMN product_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_bom_batches_product ON bom_batches(product_id);

-- 让用户仅能引用自己名下产品（防止跨用户引用）
CREATE OR REPLACE FUNCTION bom_batch_product_must_belong_to_user()
RETURNS TRIGGER AS $$
DECLARE
  ok BOOLEAN;
BEGIN
  SELECT EXISTS(
    SELECT 1 FROM products p
    WHERE p.id = NEW.product_id AND p.user_id = NEW.user_id
  ) INTO ok;

  IF NOT ok THEN
    RAISE EXCEPTION 'Invalid product_id for user';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_bom_batches_product_owner ON bom_batches;
CREATE TRIGGER trg_bom_batches_product_owner
  BEFORE INSERT OR UPDATE OF product_id, user_id ON bom_batches
  FOR EACH ROW
  EXECUTE FUNCTION bom_batch_product_must_belong_to_user();

