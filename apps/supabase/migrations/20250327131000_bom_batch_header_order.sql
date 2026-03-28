-- ============================================
-- BOM：保存导入表头顺序（jsonb 不保序）
-- ============================================

ALTER TABLE bom_batches
  ADD COLUMN IF NOT EXISTS header_order JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN bom_batches.header_order IS '导入时的表头顺序（字符串数组），用于明细页按导入顺序展示列';

