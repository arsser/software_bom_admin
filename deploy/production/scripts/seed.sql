-- Seed：测试账号 + system_settings
-- 由 supabase db reset 执行（apps/supabase/config.toml → seed.sql 符号链接）
--
-- bom_scanner.scanIntervalSeconds：worker 主循环与定时入队间隔（秒），合法范围与前端钳制一致（如 5～86400）
-- artifactory_config：占位 URL / Key，与 .env.shared.example 命名习惯一致；上线前务必在「系统设置」改为真实值，勿提交真实密钥

-- 固定测试用户（幂等：不先 DELETE，避免级联删掉该用户的 BOM 等数据；重复执行仅覆盖账号字段与 identity）
DO $$
DECLARE
  test_user_id uuid := 'e67ae1bc-4609-4a76-bb16-ca2b7a20815d';
BEGIN
  INSERT INTO auth.users (
    instance_id,
    id,
    aud,
    role,
    email,
    encrypted_password,
    email_confirmed_at,
    confirmation_token,
    recovery_token,
    email_change,
    email_change_token_new,
    email_change_token_current,
    phone_change,
    phone_change_token,
    reauthentication_token,
    raw_app_meta_data,
    raw_user_meta_data,
    created_at,
    updated_at,
    is_sso_user
  ) VALUES (
    '00000000-0000-0000-0000-000000000000',
    test_user_id,
    'authenticated',
    'authenticated',
    'test@example.com',
    crypt('test123456', gen_salt('bf')),
    NOW(),
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{}'::jsonb,
    NOW(),
    NOW(),
    false
  )
  ON CONFLICT (id) DO UPDATE SET
    instance_id = EXCLUDED.instance_id,
    aud = EXCLUDED.aud,
    role = EXCLUDED.role,
    email = EXCLUDED.email,
    encrypted_password = EXCLUDED.encrypted_password,
    email_confirmed_at = EXCLUDED.email_confirmed_at,
    raw_app_meta_data = EXCLUDED.raw_app_meta_data,
    raw_user_meta_data = EXCLUDED.raw_user_meta_data,
    updated_at = EXCLUDED.updated_at;

  INSERT INTO auth.identities (
    provider_id,
    user_id,
    identity_data,
    provider,
    last_sign_in_at,
    created_at,
    updated_at
  ) VALUES (
    test_user_id::text,
    test_user_id,
    format('{"sub":"%s","email":"%s"}', test_user_id::text, 'test@example.com')::jsonb,
    'email',
    NOW(),
    NOW(),
    NOW()
  )
  ON CONFLICT (provider_id, provider) DO UPDATE SET
    user_id = EXCLUDED.user_id,
    identity_data = EXCLUDED.identity_data,
    last_sign_in_at = EXCLUDED.last_sign_in_at,
    updated_at = EXCLUDED.updated_at;
END $$;

-- 系统配置（键名与 apps/web/src/lib/bomScannerSettings.ts、artifactorySettings.ts 一致）
INSERT INTO public.system_settings (key, value)
VALUES
  (
    'bom_scanner',
    '{
      "scanIntervalSeconds": 10,
      "jsonKeyMap": {
        "downloadUrl": ["下载路径", "url", "download_url", "下载地址"],
        "expectedMd5": ["MD5", "md5", "checksum"],
        "arch": ["硬件平台", "arch", "platform", "架构"],
        "extUrl": ["ext_url", "extUrl", "转存地址"],
        "releaseVersion": ["版本", "version", "releaseVersion", "产品版本"],
        "releaseBatch": ["批次", "batch", "releaseBatch", "发布批次"],
        "moduleName": ["模块", "module", "组件", "moduleName"],
        "groupSegment": ["分组", "group", "groupName", "组别"],
        "fileSizeBytes": ["文件大小", "size_bytes", "远端大小"],
        "extFileSizeBytes": ["ext_size_bytes", "ext文件大小", "extSize", "ext大小"],
        "remark": ["备注", "note", "remark"]
      },
      "extArtifactoryRepo": "",
      "feishuDriveRootFolderToken": "",
      "workerTuning": {
        "heartbeatMs": 5000,
        "httpTimeoutMs": 3600000,
        "httpRetries": 5
      }
    }'::jsonb
  ),
  (
    'feishu_config',
    '{"appId": "", "appSecret": ""}'::jsonb
  ),
  (
    'artifactory_config',
    '{
      "artifactoryBaseUrl": "https://it-artifactory.yitu-inc.com",
      "artifactoryApiKey": "REPLACE_WITH_ARTIFACTORY_API_KEY",
      "artifactoryExtBaseUrl": "https://it-artifactory-ext.yitu-inc.com",
      "artifactoryExtApiKey": "REPLACE_WITH_ARTIFACTORY_EXT_API_KEY"
    }'::jsonb
  )
ON CONFLICT (key) DO UPDATE
SET value = EXCLUDED.value,
    updated_at = NOW();

DO $$
BEGIN
  RAISE NOTICE 'Seed 完成：test@example.com / test123456；bom_scanner（含 scanIntervalSeconds=30）与 artifactory_config（占位凭据，请替换）。';
END $$;
