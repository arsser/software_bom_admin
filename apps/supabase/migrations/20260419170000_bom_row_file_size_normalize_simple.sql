-- 简化版：不依赖 system_settings、不创建函数；直接对 bom_rows.bom_row 执行 JSON 操作。
-- 规则：删除 size_bytes / 远端大小；把三键中第一个非空值写到规范键「文件大小」。
-- 设计目标：可重复执行、无副作用；仅在 bom_row 包含 size_bytes 或 远端大小 时改写。

DO $$
DECLARE
  affected_total integer;
  remaining integer;
BEGIN
  UPDATE public.bom_rows
  SET
    bom_row =
      (bom_row - 'size_bytes' - '远端大小')
      ||
      COALESCE(
        CASE
          WHEN COALESCE(
                 NULLIF(TRIM(bom_row->>'文件大小'), ''),
                 NULLIF(TRIM(bom_row->>'size_bytes'), ''),
                 NULLIF(TRIM(bom_row->>'远端大小'), '')
               ) IS NOT NULL
          THEN jsonb_build_object('文件大小',
                 COALESCE(
                   NULLIF(TRIM(bom_row->>'文件大小'), ''),
                   NULLIF(TRIM(bom_row->>'size_bytes'), ''),
                   NULLIF(TRIM(bom_row->>'远端大小'), '')
                 ))
          ELSE NULL
        END,
        '{}'::jsonb
      ),
    updated_at = now()
  WHERE bom_row IS NOT NULL
    AND jsonb_typeof(bom_row) = 'object'
    AND (bom_row ? 'size_bytes' OR bom_row ? '远端大小');

  GET DIAGNOSTICS affected_total = ROW_COUNT;
  RAISE NOTICE '[bom_row_file_size_normalize_simple] updated rows: %', affected_total;

  SELECT count(*)
  INTO remaining
  FROM public.bom_rows
  WHERE bom_row IS NOT NULL
    AND jsonb_typeof(bom_row) = 'object'
    AND (bom_row ? 'size_bytes' OR bom_row ? '远端大小');

  RAISE NOTICE '[bom_row_file_size_normalize_simple] rows still containing size_bytes or 远端大小 after update: %', remaining;
END;
$$;
