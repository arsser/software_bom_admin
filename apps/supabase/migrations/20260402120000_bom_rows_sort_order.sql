-- BOM 行固定排序：与粘贴/保存顺序一致，避免仅按 created_at 时时间戳相同导致顺序不稳定

ALTER TABLE bom_rows
  ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN bom_rows.sort_order IS '批次内行序（0 起），与入库时数组下标一致';

-- 历史数据：按既有 created_at、id 赋予稳定顺序
UPDATE bom_rows br
SET sort_order = sub.rn
FROM (
  SELECT
    id,
    (ROW_NUMBER() OVER (PARTITION BY batch_id ORDER BY created_at ASC, id ASC) - 1)::integer AS rn
  FROM bom_rows
) sub
WHERE br.id = sub.id;

CREATE INDEX IF NOT EXISTS idx_bom_rows_batch_sort ON bom_rows (batch_id, sort_order);
