-- 手动维护用：把 bom_scanner.jsonKeyMap 设为规范的 module / component（与 apps/web bomScannerSettings 默认一致），
-- 并删除旧键 groupSegment、moduleName。不读取、不合并旧别名——需要自定义时在 UPDATE 里改两处数组即可。
--
-- module：分组 / 模块层列别名
-- component：组件列别名

-- ---------------------------------------------------------------------------
-- 1) 查询当前 jsonKeyMap（可选）
-- ---------------------------------------------------------------------------
SELECT key, jsonb_pretty(value -> 'jsonKeyMap') AS json_key_map
FROM public.system_settings
WHERE key = 'bom_scanner';

-- ---------------------------------------------------------------------------
-- 2) 直接写入新键并删掉旧键（括号避免 -> 与 - 优先级问题）
-- ---------------------------------------------------------------------------
UPDATE public.system_settings
SET value = jsonb_set(
  value,
  '{jsonKeyMap}',
  (
    ((value -> 'jsonKeyMap')::jsonb - 'groupSegment' - 'moduleName')
    || jsonb_build_object(
      'module', '["分组", "group", "groupName", "组别", "模块"]'::jsonb,
      'component', '["组件", "Component", "组件名"]'::jsonb
    )
  ),
  true
)
WHERE key = 'bom_scanner'
  AND value ? 'jsonKeyMap';

-- ---------------------------------------------------------------------------
-- 3) 复查
-- ---------------------------------------------------------------------------
SELECT
  jsonb_pretty(value -> 'jsonKeyMap' -> 'module') AS module,
  jsonb_pretty(value -> 'jsonKeyMap' -> 'component') AS component
FROM public.system_settings
WHERE key = 'bom_scanner';
