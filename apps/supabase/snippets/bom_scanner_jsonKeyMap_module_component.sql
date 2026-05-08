-- 手动维护用：bom_scanner.jsonKeyMap 从旧键 groupSegment / moduleName 改为 module / component
-- （非 migrations；部署新代码前请在目标库执行「修改」段，或自行核对后再执行）
--
-- 约定：
--   module    <- 原 groupSegment（分组、模块等列别名）
--   component <- 原 moduleName（组件等列别名）

-- ---------------------------------------------------------------------------
-- 1) 查询：当前 jsonKeyMap 中相关键（含是否仍存在旧键）
-- ---------------------------------------------------------------------------
SELECT
  key AS settings_key,
  (value->'jsonKeyMap'->'module') IS NOT NULL AS has_module,
  (value->'jsonKeyMap'->'component') IS NOT NULL AS has_component,
  (value->'jsonKeyMap'->'groupSegment') IS NOT NULL AS has_legacy_group_segment,
  (value->'jsonKeyMap'->'moduleName') IS NOT NULL AS has_legacy_module_name,
  value->'jsonKeyMap'->'module' AS module,
  value->'jsonKeyMap'->'component' AS component,
  value->'jsonKeyMap'->'groupSegment' AS legacy_group_segment,
  value->'jsonKeyMap'->'moduleName' AS legacy_module_name
FROM public.system_settings
WHERE key = 'bom_scanner';

-- 可选：只看整段 jsonKeyMap
-- SELECT key, jsonb_pretty(value->'jsonKeyMap') FROM public.system_settings WHERE key = 'bom_scanner';

-- ---------------------------------------------------------------------------
-- 2) 修改：合并新键并删除旧键（一次性 UPDATE）
--    规则：非空数组优先用已有 module / component；否则用 groupSegment / moduleName；
--    再否则写入与前端 defaultJsonKeyMap 一致的默认别名数组。
--    执行前请先用上面的 SELECT 确认只有一行 bom_scanner。
-- ---------------------------------------------------------------------------
UPDATE public.system_settings
SET value = jsonb_set(
  value,
  '{jsonKeyMap}',
  (value->'jsonKeyMap' - 'groupSegment' - 'moduleName')
    || jsonb_build_object(
      'module',
      CASE
        WHEN jsonb_typeof(value #> '{jsonKeyMap,module}') = 'array'
          AND jsonb_array_length(value #> '{jsonKeyMap,module}') > 0
        THEN value #> '{jsonKeyMap,module}'
        WHEN jsonb_typeof(value #> '{jsonKeyMap,groupSegment}') = 'array'
          AND jsonb_array_length(value #> '{jsonKeyMap,groupSegment}') > 0
        THEN value #> '{jsonKeyMap,groupSegment}'
        ELSE '["分组", "group", "groupName", "组别", "模块"]'::jsonb
      END,
      'component',
      CASE
        WHEN jsonb_typeof(value #> '{jsonKeyMap,component}') = 'array'
          AND jsonb_array_length(value #> '{jsonKeyMap,component}') > 0
        THEN value #> '{jsonKeyMap,component}'
        WHEN jsonb_typeof(value #> '{jsonKeyMap,moduleName}') = 'array'
          AND jsonb_array_length(value #> '{jsonKeyMap,moduleName}') > 0
        THEN value #> '{jsonKeyMap,moduleName}'
        ELSE '["组件", "Component", "组件名"]'::jsonb
      END
    ),
  true
)
WHERE key = 'bom_scanner'
  AND value ? 'jsonKeyMap';

-- ---------------------------------------------------------------------------
-- 3) 修改后复查
-- ---------------------------------------------------------------------------
SELECT
  jsonb_pretty(value->'jsonKeyMap'->'module') AS module,
  jsonb_pretty(value->'jsonKeyMap'->'component') AS component
FROM public.system_settings
WHERE key = 'bom_scanner';
