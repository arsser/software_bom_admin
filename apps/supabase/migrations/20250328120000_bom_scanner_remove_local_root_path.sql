-- 暂存根目录由 compose/env 与 worker 挂载决定，不再存入 system_settings.bom_scanner
UPDATE system_settings
SET value = value - 'localRootPath'
WHERE key = 'bom_scanner'
  AND value ? 'localRootPath';
