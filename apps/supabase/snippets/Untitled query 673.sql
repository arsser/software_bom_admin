-- Seed data for Admin Starter
-- This file is automatically executed when running 'supabase db reset'
-- Located in deploy/production/; config.toml sql_paths points here

-- Create test user for development
-- Email: test@example.com
-- Password: test123456

-- 使用固定的用户ID，以便所有数据保持一致的外键引用
-- Delete existing test user if exists (for clean reset)
DELETE FROM auth.users WHERE id = 'e67ae1bc-4609-4a76-bb16-ca2b7a20815d';
DELETE FROM auth.users WHERE email = 'test@example.com';

-- Insert user into auth.users table with fixed ID
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
    crypt('test123456', gen_salt('bf')), -- Password: test123456
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
  );

  -- Insert identity for the user
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
  );
END $$;

-- Upsert ping settings (cron + thresholds)
INSERT INTO system_settings (key, value)
VALUES (
  'ping_settings',
  '{
    "enabled": true,
    "cronExpression": "*/5 * * * *",
    "timeoutMs": 5000,
    "maxLatencyMs": 1500,
    "maxTargetsPerRun": 50
  }'::jsonb
)
ON CONFLICT (key) DO UPDATE
SET value = EXCLUDED.value,
    updated_at = NOW();

-- Insert ping targets (真实数据)
INSERT INTO ping_targets (id, user_id, domain, label, enabled, success_count, failure_count, total_latency_ms, first_checked_at, last_checked_at, created_at) VALUES
  ('c609035e-898d-42db-ae54-16822f7a39c1', 'e67ae1bc-4609-4a76-bb16-ca2b7a20815d', 'www.jd.com', NULL, true, 2, 0, 294, '2025-12-28 05:17:00.036012+00', '2025-12-28 05:18:00.011233+00', '2025-12-28 05:16:59.991428+00'),
  ('b2aa82ec-8533-43d1-aa1a-59defdcd3ed5', 'e67ae1bc-4609-4a76-bb16-ca2b7a20815d', 'www.taobao.com', NULL, true, 1, 0, 57, '2025-12-28 05:18:00.011233+00', '2025-12-28 05:18:00.011233+00', '2025-12-28 05:17:05.664468+00'),
  ('61dbed30-e1c5-4018-bc15-0688d75f0d23', 'e67ae1bc-4609-4a76-bb16-ca2b7a20815d', 'www.163.net', NULL, true, 1, 0, 600, '2025-12-28 05:18:00.011233+00', '2025-12-28 05:18:00.011233+00', '2025-12-28 05:17:12.971802+00');

-- Insert ping logs (真实数据)
INSERT INTO ping_logs (id, target_id, user_id, domain, success, status_code, latency_ms, error, checked_at) VALUES
  (1, 'c609035e-898d-42db-ae54-16822f7a39c1', 'e67ae1bc-4609-4a76-bb16-ca2b7a20815d', 'www.jd.com', true, 200, 235, NULL, '2025-12-28 05:17:00.036012+00'),
  (2, '61dbed30-e1c5-4018-bc15-0688d75f0d23', 'e67ae1bc-4609-4a76-bb16-ca2b7a20815d', 'www.163.net', true, 200, 600, NULL, '2025-12-28 05:18:00.011233+00'),
  (3, 'b2aa82ec-8533-43d1-aa1a-59defdcd3ed5', 'e67ae1bc-4609-4a76-bb16-ca2b7a20815d', 'www.taobao.com', true, 200, 57, NULL, '2025-12-28 05:18:00.011233+00'),
  (4, 'c609035e-898d-42db-ae54-16822f7a39c1', 'e67ae1bc-4609-4a76-bb16-ca2b7a20815d', 'www.jd.com', true, 200, 59, NULL, '2025-12-28 05:18:00.011233+00');

-- Reset ping_logs sequence
SELECT setval('ping_logs_id_seq', (SELECT COALESCE(MAX(id), 0) FROM ping_logs) + 1, false);

-- Insert downloaded_images (真实数据 - 图片文件由 init-storage 脚本上传)
INSERT INTO downloaded_images (id, user_id, original_url, storage_path, file_name, file_size, mime_type, status, description, created_at, updated_at) VALUES
  ('2bce1ac0-6d00-4364-8cd5-beac9dce07b4', 'e67ae1bc-4609-4a76-bb16-ca2b7a20815d', 'https://ichef.bbci.co.uk/ace/standard/976/cpsprodpb/d677/live/6ca60740-df07-11ef-ab1e-5bd06fea511f.jpg.webp', 'e67ae1bc-4609-4a76-bb16-ca2b7a20815d/1766899058361_t0hbg.webp', '6ca60740-df07-11ef-ab1e-5bd06fea511f.jpg.webp', 32898, 'image/webp', 'completed', 'Māori are people indigenous to New Zealand, which means they were the first people to live in the country.', '2025-12-28 05:17:38.707641+00', '2025-12-28 05:17:38.901982+00'),
  ('fd25475e-fb57-4fa4-a23f-be71dda8d025', 'e67ae1bc-4609-4a76-bb16-ca2b7a20815d', 'https://ichef.bbci.co.uk/ace/standard/976/cpsprodpb/7847/live/1c543320-df07-11ef-ab1e-5bd06fea511f.jpg.webp', 'e67ae1bc-4609-4a76-bb16-ca2b7a20815d/1766899076797_gfom9f.webp', '1c543320-df07-11ef-ab1e-5bd06fea511f.jpg.webp', 81510, 'image/webp', 'completed', 'Whanganui River, known by Māori as Te Awa Tupua, is the third longest in New Zealand', '2025-12-28 05:17:56.991857+00', '2025-12-28 05:17:57.1076+00');

-- Ensure ping cron job matches seed configuration (every 5 minutes)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ping-domains') THEN
    PERFORM cron.unschedule('ping-domains');
  END IF;

  PERFORM cron.schedule(
    'ping-domains',
    '*/5 * * * *',
    $cron$SELECT ping_enabled_domains();$cron$
  );
END $$;

-- Success message
DO $$
BEGIN
  RAISE NOTICE 'Seed data created successfully!';
  RAISE NOTICE 'Test account - Email: test@example.com, Password: test123456';
  RAISE NOTICE 'Run "cd deploy/production && pnpm run init-storage" to upload sample images to Storage.';
END $$;
