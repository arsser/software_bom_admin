-- ============================================
-- BOM Lite 阶段 0：批次/行（jsonb）、本地文件索引、扫描配置
-- ============================================

-- 统一业务状态（DB 英文枚举，UI 中文见前端映射）
DO $$ BEGIN
  CREATE TYPE bom_row_status AS ENUM (
    'pending',
    'await_manual_download',
    'local_found',
    'verified_ok',
    'verified_fail',
    'synced_or_skipped',
    'error'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

COMMENT ON TYPE bom_row_status IS 'BOM 行业务状态：pending=待处理, await_manual_download=待人工下载, local_found=本地已发现, verified_ok=校验通过, verified_fail=校验失败, synced_or_skipped=已转存或跳过, error=异常';

-- BOM 批次（元数据不重复存 URL/MD5 等业务列）
CREATE TABLE IF NOT EXISTS bom_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE bom_batches IS 'BOM 批次/名称';
COMMENT ON COLUMN bom_batches.name IS '批次显示名或清单名';

CREATE INDEX IF NOT EXISTS idx_bom_batches_user ON bom_batches(user_id);
CREATE INDEX IF NOT EXISTS idx_bom_batches_created ON bom_batches(created_at DESC);

-- 每行唯一事实来源：bom_row jsonb
CREATE TABLE IF NOT EXISTS bom_rows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id UUID NOT NULL REFERENCES bom_batches(id) ON DELETE CASCADE,
  bom_row JSONB NOT NULL DEFAULT '{}'::jsonb,
  status bom_row_status NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE bom_rows IS 'BOM 行：bom_row 为唯一事实来源';
COMMENT ON COLUMN bom_rows.bom_row IS '整行原始结构（列名可变，解析层按配置 key 映射）';
COMMENT ON COLUMN bom_rows.status IS '统一状态机';

CREATE INDEX IF NOT EXISTS idx_bom_rows_batch ON bom_rows(batch_id);
CREATE INDEX IF NOT EXISTS idx_bom_rows_status ON bom_rows(status);

-- 本地磁盘索引（相对仓库根或整站统一绝对路径，由配置约定）
CREATE TABLE IF NOT EXISTS local_file (
  path TEXT PRIMARY KEY,
  size_bytes BIGINT NOT NULL DEFAULT 0,
  mtime TIMESTAMPTZ,
  md5 TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE local_file IS '本地暂存目录扫描索引';
COMMENT ON COLUMN local_file.path IS '相对根目录或绝对路径（整站固定一种）';
COMMENT ON COLUMN local_file.md5 IS '内容 MD5，未算出前可为空';

CREATE INDEX IF NOT EXISTS idx_local_file_md5 ON local_file(md5) WHERE md5 IS NOT NULL;

-- 触发器：updated_at
DROP TRIGGER IF EXISTS update_bom_batches_updated_at ON bom_batches;
CREATE TRIGGER update_bom_batches_updated_at
  BEFORE UPDATE ON bom_batches
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_bom_rows_updated_at ON bom_rows;
CREATE TRIGGER update_bom_rows_updated_at
  BEFORE UPDATE ON bom_rows
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_local_file_updated_at ON local_file;
CREATE TRIGGER update_local_file_updated_at
  BEFORE UPDATE ON local_file
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- RLS
ALTER TABLE bom_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE bom_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE local_file ENABLE ROW LEVEL SECURITY;

-- bom_batches：属主
DROP POLICY IF EXISTS "Users manage own bom batches" ON bom_batches;
CREATE POLICY "Users manage own bom batches"
  ON bom_batches FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Service role full bom batches" ON bom_batches;
CREATE POLICY "Service role full bom batches"
  ON bom_batches FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- bom_rows：通过 batch 属主
DROP POLICY IF EXISTS "Users manage bom rows via own batch" ON bom_rows;
CREATE POLICY "Users manage bom rows via own batch"
  ON bom_rows FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM bom_batches b
      WHERE b.id = bom_rows.batch_id AND b.user_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM bom_batches b
      WHERE b.id = bom_rows.batch_id AND b.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Service role full bom rows" ON bom_rows;
CREATE POLICY "Service role full bom rows"
  ON bom_rows FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- local_file：单实例管理端，与 system_settings 一致对认证用户可读写
DROP POLICY IF EXISTS "Authenticated can read local_file" ON local_file;
CREATE POLICY "Authenticated can read local_file"
  ON local_file FOR SELECT
  USING (auth.role() IN ('authenticated', 'service_role'));

DROP POLICY IF EXISTS "Authenticated can insert local_file" ON local_file;
CREATE POLICY "Authenticated can insert local_file"
  ON local_file FOR INSERT
  WITH CHECK (auth.role() IN ('authenticated', 'service_role'));

DROP POLICY IF EXISTS "Authenticated can update local_file" ON local_file;
CREATE POLICY "Authenticated can update local_file"
  ON local_file FOR UPDATE
  USING (auth.role() IN ('authenticated', 'service_role'));

DROP POLICY IF EXISTS "Authenticated can delete local_file" ON local_file;
CREATE POLICY "Authenticated can delete local_file"
  ON local_file FOR DELETE
  USING (auth.role() IN ('authenticated', 'service_role'));

-- 默认扫描配置（可被 UI 覆盖）
INSERT INTO system_settings (key, value)
VALUES (
  'bom_scanner',
  '{
    "scanIntervalSeconds": 30,
    "jsonKeyMap": {
      "downloadUrl": ["下载路径","url","download_url","下载地址"],
      "expectedMd5": ["MD5","md5","checksum"],
      "arch": ["硬件平台","arch","platform","架构"],
      "extUrl": ["ext_url","extUrl","转存地址"]
    }
  }'::jsonb
)
ON CONFLICT (key) DO NOTHING;
