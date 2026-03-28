-- 扫描间隔改为秒：与 worker 轮询周期、定时入队间隔合一（替代 scanIntervalMinutes）
UPDATE system_settings
SET value = CASE
  WHEN value ? 'scanIntervalSeconds' THEN value - 'scanIntervalMinutes'
  WHEN value ? 'scanIntervalMinutes' THEN
    (value - 'scanIntervalMinutes')
    || jsonb_build_object(
      'scanIntervalSeconds',
      GREATEST(
        5,
        LEAST(
          86400,
          COALESCE(NULLIF((value->>'scanIntervalMinutes')::int, 0), 15) * 60
        )
      )
    )
  ELSE COALESCE(value, '{}'::jsonb) || '{"scanIntervalSeconds": 30}'::jsonb
END
WHERE key = 'bom_scanner';
