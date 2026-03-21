-- ============================================
--  Admin Starter 数据库初始化脚本
-- ============================================
-- 此脚本包含完整的数据库结构：表、索引、触发器、RLS策略等
-- 执行方式：
--   1. 本地 Supabase: supabase db reset 或 supabase migration up
--   2. 远程 Supabase: 在 Supabase Dashboard > SQL Editor 中执行此脚本
-- ============================================
-- 更新日期: 2025-12-27
-- 版本: 域名监测功能
-- ============================================

-- ============================================
-- 0. 启用扩展（pg_cron / http）
-- ============================================

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS http;

COMMENT ON EXTENSION pg_cron IS 'PostgreSQL 定时任务扩展，用于定时检测域名';
COMMENT ON EXTENSION http IS 'PostgreSQL HTTP 扩展，用于 HTTP 请求';

-- ============================================
-- 1. 创建表结构
-- ============================================

-- system_settings 表：系统设置（全局，无 user 维度）
CREATE TABLE IF NOT EXISTS system_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key TEXT NOT NULL UNIQUE,
  value JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE system_settings IS '系统设置表（全局配置，无用户维度）';

-- ping_targets 表：域名监测目标
CREATE TABLE IF NOT EXISTS ping_targets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  domain TEXT NOT NULL,
  label TEXT,
  enabled BOOLEAN NOT NULL DEFAULT true,
  success_count INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0,
  total_latency_ms BIGINT NOT NULL DEFAULT 0,
  first_checked_at TIMESTAMPTZ,
  last_checked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, domain)
);

COMMENT ON TABLE ping_targets IS '域名监测目标';
COMMENT ON COLUMN ping_targets.total_latency_ms IS '累计成功延迟（毫秒），用于计算平均延迟';

-- ping_logs 表：域名监测日志
CREATE TABLE IF NOT EXISTS ping_logs (
  id BIGSERIAL PRIMARY KEY,
  target_id UUID REFERENCES ping_targets(id) ON DELETE CASCADE,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  domain TEXT NOT NULL,
  success BOOLEAN NOT NULL DEFAULT false,
  status_code INTEGER,
  latency_ms INTEGER,
  error TEXT,
  checked_at TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE ping_logs IS '域名监测日志';

-- downloaded_images 表：用户下载的图片记录
CREATE TABLE IF NOT EXISTS downloaded_images (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  original_url TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  file_name TEXT,
  file_size INTEGER,
  mime_type TEXT,
  width INTEGER,
  height INTEGER,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'downloading', 'completed', 'failed')),
  error_message TEXT,
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE downloaded_images IS '用户下载的图片记录';
COMMENT ON COLUMN downloaded_images.original_url IS '原始图片 URL';
COMMENT ON COLUMN downloaded_images.storage_path IS 'Supabase Storage 中的相对路径（完整 URL = supabase_url + /storage/v1/object/public/downloaded-images/ + storage_path）';
COMMENT ON COLUMN downloaded_images.status IS '下载状态：pending-等待下载, downloading-下载中, completed-已完成, failed-失败';
COMMENT ON COLUMN downloaded_images.description IS '图片描述，用户可编辑';

-- ============================================
-- 2. 创建索引
-- ============================================

-- system_settings 表索引
CREATE INDEX IF NOT EXISTS idx_system_settings_key ON system_settings(key);

-- ping_targets 表索引
CREATE INDEX IF NOT EXISTS idx_ping_targets_user ON ping_targets(user_id);
CREATE INDEX IF NOT EXISTS idx_ping_targets_enabled ON ping_targets(enabled);
CREATE INDEX IF NOT EXISTS idx_ping_targets_success_rate ON ping_targets(user_id, enabled, success_count, failure_count);

-- ping_logs 表索引
CREATE INDEX IF NOT EXISTS idx_ping_logs_user_time ON ping_logs(user_id, checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_ping_logs_target_time ON ping_logs(target_id, checked_at DESC);

-- downloaded_images 表索引
CREATE INDEX IF NOT EXISTS idx_downloaded_images_user_id ON downloaded_images(user_id);
CREATE INDEX IF NOT EXISTS idx_downloaded_images_status ON downloaded_images(status);
CREATE INDEX IF NOT EXISTS idx_downloaded_images_created_at ON downloaded_images(created_at DESC);

-- ============================================
-- 3. 创建触发器函数
-- ============================================

-- 触发器函数：自动更新 system_settings.updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION update_updated_at_column() IS '自动更新 updated_at 字段';

-- ============================================
-- 4. 创建触发器
-- ============================================

-- 触发器：自动更新 system_settings.updated_at
DROP TRIGGER IF EXISTS update_system_settings_updated_at ON system_settings;
CREATE TRIGGER update_system_settings_updated_at
  BEFORE UPDATE ON system_settings
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- 触发器：自动更新 downloaded_images.updated_at
CREATE OR REPLACE FUNCTION update_downloaded_images_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_downloaded_images_updated_at ON downloaded_images;
CREATE TRIGGER update_downloaded_images_updated_at
  BEFORE UPDATE ON downloaded_images
  FOR EACH ROW
  EXECUTE FUNCTION update_downloaded_images_updated_at();

-- ============================================
-- 5. 启用 Row Level Security (RLS)
-- ============================================

ALTER TABLE system_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE ping_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE ping_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE downloaded_images ENABLE ROW LEVEL SECURITY;

-- ============================================
-- 6. 创建 RLS 策略
-- ============================================

-- system_settings 表策略（全局配置，需认证/服务角色）
DROP POLICY IF EXISTS "Authenticated can read settings" ON system_settings;
CREATE POLICY "Authenticated can read settings"
  ON system_settings FOR SELECT
  USING (auth.role() IN ('authenticated', 'service_role'));

DROP POLICY IF EXISTS "Authenticated can write settings" ON system_settings;
CREATE POLICY "Authenticated can write settings"
  ON system_settings FOR INSERT
  WITH CHECK (auth.role() IN ('authenticated', 'service_role'));

DROP POLICY IF EXISTS "Authenticated can update settings" ON system_settings;
CREATE POLICY "Authenticated can update settings"
  ON system_settings FOR UPDATE
  USING (auth.role() IN ('authenticated', 'service_role'));

DROP POLICY IF EXISTS "Authenticated can delete settings" ON system_settings;
CREATE POLICY "Authenticated can delete settings"
  ON system_settings FOR DELETE
  USING (auth.role() IN ('authenticated', 'service_role'));

-- ping_targets 表策略
DROP POLICY IF EXISTS "Users can view own ping targets" ON ping_targets;
CREATE POLICY "Users can view own ping targets"
  ON ping_targets FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can manage own ping targets" ON ping_targets;
CREATE POLICY "Users can manage own ping targets"
  ON ping_targets FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Service role can manage ping targets" ON ping_targets;
CREATE POLICY "Service role can manage ping targets"
  ON ping_targets FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ping_logs 表策略
DROP POLICY IF EXISTS "Users can view own ping logs" ON ping_logs;
CREATE POLICY "Users can view own ping logs"
  ON ping_logs FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Service role can manage ping logs" ON ping_logs;
CREATE POLICY "Service role can manage ping logs"
  ON ping_logs FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- downloaded_images 表策略
DROP POLICY IF EXISTS "Users can view own images" ON downloaded_images;
CREATE POLICY "Users can view own images"
  ON downloaded_images FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own images" ON downloaded_images;
CREATE POLICY "Users can insert own images"
  ON downloaded_images FOR INSERT
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own images" ON downloaded_images;
CREATE POLICY "Users can update own images"
  ON downloaded_images FOR UPDATE
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete own images" ON downloaded_images;
CREATE POLICY "Users can delete own images"
  ON downloaded_images FOR DELETE
  USING (auth.uid() = user_id);

-- ============================================
-- 7. 域名监测函数与 cron 任务
-- ============================================

-- 函数：对启用的域名执行 HTTP ping 并记录结果
CREATE OR REPLACE FUNCTION ping_enabled_domains(
  p_max_targets INTEGER DEFAULT 50,
  p_timeout_ms INTEGER DEFAULT 5000
) RETURNS TABLE(
  domain TEXT,
  success BOOLEAN,
  status_code INTEGER,
  latency_ms INTEGER,
  error TEXT,
  checked_at TIMESTAMPTZ
) AS $$
DECLARE
  v_target RECORD;
  v_started TIMESTAMPTZ;
  v_resp http_response;
  v_ok BOOLEAN;
  v_status INTEGER;
  v_latency_ms INTEGER;
  v_err TEXT;
  v_now TIMESTAMPTZ := clock_timestamp();
BEGIN
  FOR v_target IN
    SELECT * FROM ping_targets
    WHERE enabled = true
    ORDER BY created_at DESC
    LIMIT p_max_targets
  LOOP
    v_started := clock_timestamp();
    v_ok := false;
    v_status := NULL;
    v_latency_ms := NULL;
    v_err := NULL;

    BEGIN
      SELECT * INTO v_resp
      FROM http((
        'GET',
        CASE
          WHEN v_target.domain ILIKE 'http%' THEN v_target.domain
          ELSE 'https://' || v_target.domain
        END,
        ARRAY[http_header('User-Agent', 'ping-monitor/1.0')],
        NULL,
        NULL
      )::http_request);

      v_status := v_resp.status;
      v_latency_ms := CEIL((EXTRACT(EPOCH FROM (clock_timestamp() - v_started)) * 1000))::INT;
      v_ok := v_status BETWEEN 200 AND 399;
    EXCEPTION
      WHEN OTHERS THEN
        v_err := SQLERRM;
        v_latency_ms := CEIL((EXTRACT(EPOCH FROM (clock_timestamp() - v_started)) * 1000))::INT;
        v_ok := false;
    END;

    INSERT INTO ping_logs (target_id, user_id, domain, success, status_code, latency_ms, error, checked_at)
    VALUES (v_target.id, v_target.user_id, v_target.domain, v_ok, v_status, v_latency_ms, v_err, v_now);

    IF v_ok THEN
      UPDATE ping_targets
      SET success_count = success_count + 1,
          total_latency_ms = total_latency_ms + COALESCE(v_latency_ms, 0),
          last_checked_at = v_now,
          first_checked_at = COALESCE(first_checked_at, v_now)
      WHERE id = v_target.id;
    ELSE
      UPDATE ping_targets
      SET failure_count = failure_count + 1,
          last_checked_at = v_now,
          first_checked_at = COALESCE(first_checked_at, v_now)
      WHERE id = v_target.id;
    END IF;

    domain := v_target.domain;
    success := v_ok;
    status_code := v_status;
    latency_ms := v_latency_ms;
    error := v_err;
    checked_at := clock_timestamp();
    RETURN NEXT;
  END LOOP;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION ping_enabled_domains(INTEGER, INTEGER) IS '对启用的域名执行 HTTP ping 并记录结果';

-- 函数：更新域名监测 cron
CREATE OR REPLACE FUNCTION update_ping_cron_job(
  p_cron_expression TEXT,
  p_enabled BOOLEAN DEFAULT true
) RETURNS BOOLEAN AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'User must be authenticated';
  END IF;

  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ping-domains') THEN
    PERFORM cron.unschedule('ping-domains');
  END IF;

  IF p_enabled THEN
    PERFORM cron.schedule(
      'ping-domains',
      p_cron_expression,
      $ping$SELECT ping_enabled_domains();$ping$
    );
  END IF;

  RETURN true;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION ping_enabled_domains(INTEGER, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION update_ping_cron_job(TEXT, BOOLEAN) TO authenticated, service_role;

-- 单次检测
CREATE OR REPLACE FUNCTION ping_domain_now(
  p_target_id UUID
) RETURNS TABLE(
  domain TEXT,
  success BOOLEAN,
  status_code INTEGER,
  latency_ms INTEGER,
  error TEXT,
  checked_at TIMESTAMPTZ
) AS $$
DECLARE
  v_target ping_targets%ROWTYPE;
  v_started TIMESTAMPTZ;
  v_resp http_response;
  v_ok BOOLEAN := false;
  v_status INTEGER;
  v_latency_ms INTEGER;
  v_err TEXT;
  v_now TIMESTAMPTZ := clock_timestamp();
BEGIN
  SELECT * INTO v_target FROM ping_targets WHERE id = p_target_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Target not found';
  END IF;

  v_started := clock_timestamp();

  BEGIN
    SELECT * INTO v_resp
    FROM http((
      'GET',
      CASE
        WHEN v_target.domain ILIKE 'http%' THEN v_target.domain
        ELSE 'https://' || v_target.domain
      END,
      ARRAY[http_header('User-Agent', 'ping-monitor/1.0')],
      NULL,
      NULL
    )::http_request);

    v_status := v_resp.status;
    v_latency_ms := CEIL((EXTRACT(EPOCH FROM (clock_timestamp() - v_started)) * 1000))::INT;
    v_ok := v_status BETWEEN 200 AND 399;
  EXCEPTION
    WHEN OTHERS THEN
      v_err := SQLERRM;
      v_latency_ms := CEIL((EXTRACT(EPOCH FROM (clock_timestamp() - v_started)) * 1000))::INT;
      v_ok := false;
  END;

  INSERT INTO ping_logs (target_id, user_id, domain, success, status_code, latency_ms, error, checked_at)
  VALUES (v_target.id, v_target.user_id, v_target.domain, v_ok, v_status, v_latency_ms, v_err, v_now);

  IF v_ok THEN
    UPDATE ping_targets
    SET success_count = success_count + 1,
        total_latency_ms = total_latency_ms + COALESCE(v_latency_ms, 0),
        last_checked_at = v_now,
        first_checked_at = COALESCE(first_checked_at, v_now)
    WHERE id = v_target.id;
  ELSE
    UPDATE ping_targets
    SET failure_count = failure_count + 1,
        last_checked_at = v_now,
        first_checked_at = COALESCE(first_checked_at, v_now)
    WHERE id = v_target.id;
  END IF;

  domain := v_target.domain;
  success := v_ok;
  status_code := v_status;
  latency_ms := v_latency_ms;
  error := v_err;
  checked_at := clock_timestamp();
  RETURN NEXT;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 清除计数
CREATE OR REPLACE FUNCTION reset_ping_counts(
  p_target_id UUID
) RETURNS BOOLEAN AS $$
BEGIN
  UPDATE ping_targets
  SET success_count = 0,
      failure_count = 0,
      total_latency_ms = 0,
      first_checked_at = NULL,
      last_checked_at = NULL
  WHERE id = p_target_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Target not found';
  END IF;
  RETURN true;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION ping_domain_now(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION reset_ping_counts(UUID) TO authenticated, service_role;

-- ============================================
-- 8. Storage：downloaded-images bucket 与策略
-- ============================================

-- 创建存储桶（公开读取，受 RLS 控制上传/删除）
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'downloaded-images',
  'downloaded-images',
  true,
  52428800,  -- 50MB
  ARRAY['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml']
)
ON CONFLICT (id) DO NOTHING;

-- 允许认证用户上传图片
DROP POLICY IF EXISTS "Allow authenticated users to upload images" ON storage.objects;
CREATE POLICY "Allow authenticated users to upload images"
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (bucket_id = 'downloaded-images');

-- 允许用户读取自己的图片
DROP POLICY IF EXISTS "Allow users to read own images" ON storage.objects;
CREATE POLICY "Allow users to read own images"
ON storage.objects
FOR SELECT
TO authenticated
USING (bucket_id = 'downloaded-images' AND auth.uid()::text = (storage.foldername(name))[1]);

-- 允许公众读取（桶为 public）
DROP POLICY IF EXISTS "Allow public read access to downloaded images" ON storage.objects;
CREATE POLICY "Allow public read access to downloaded images"
ON storage.objects
FOR SELECT
TO public
USING (bucket_id = 'downloaded-images');

-- 允许用户删除自己的图片
DROP POLICY IF EXISTS "Allow users to delete own images" ON storage.objects;
CREATE POLICY "Allow users to delete own images"
ON storage.objects
FOR DELETE
TO authenticated
USING (bucket_id = 'downloaded-images' AND auth.uid()::text = (storage.foldername(name))[1]);

-- ============================================
-- 初始化完成
-- ============================================
