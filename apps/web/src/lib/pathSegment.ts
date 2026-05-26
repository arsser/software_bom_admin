/**
 * 路径段规范化，与 bom-scanner-worker extArtifactorySync.safePathSegment 保持一致。
 * 用于组装表模块名校验，确保 BOM / 飞书目录名与 worker 扫描路径一致。
 */

/** 多模块引用同一组件ID 时的合并分隔符（模块名内不得包含此串） */
export const MODULE_MERGE_SEP = '--';

export const PATH_SEGMENT_MAX_LEN = 160;

const PATH_SEGMENT_FORBIDDEN = /[/\\?*:|"<>]/;

export function normalizePathSegmentValue(seg: unknown): string {
  return String(seg ?? '')
    .normalize('NFKC')
    .replace(/[\u200b-\u200d\ufeff\u3000]/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** @see apps/bom-scanner-worker/src/extArtifactorySync.mjs safePathSegment */
export function safePathSegment(seg: string): string {
  const t = normalizePathSegmentValue(seg)
    .replace(PATH_SEGMENT_FORBIDDEN, '_')
    .replace(/\s+/g, ' ')
    .slice(0, PATH_SEGMENT_MAX_LEN);
  return t || 'unknown';
}

/** 校验单个模块名；通过则返回规范化后的名称，否则返回错误说明 */
export function validateModuleSegmentName(raw: string): { ok: true; value: string } | { ok: false; error: string } {
  const t = normalizePathSegmentValue(raw);
  if (!t) {
    return { ok: false, error: '模块名不能为空' };
  }
  if (t.includes(MODULE_MERGE_SEP)) {
    return { ok: false, error: `模块名不得包含合并分隔符「${MODULE_MERGE_SEP}」` };
  }
  if (t.includes('&')) {
    return { ok: false, error: '模块名不得包含「&」' };
  }
  if (PATH_SEGMENT_FORBIDDEN.test(t)) {
    return { ok: false, error: '模块名不得包含路径非法字符：/ \\ ? * : | " < >' };
  }
  if (t.length > PATH_SEGMENT_MAX_LEN) {
    return { ok: false, error: `模块名过长（最多 ${PATH_SEGMENT_MAX_LEN} 个字符）` };
  }
  if (safePathSegment(t) !== t) {
    return { ok: false, error: '模块名含有无法用于飞书目录的字符' };
  }
  return { ok: true, value: t };
}

export function mergeModuleSegmentNames(modules: string[]): string {
  return modules.join(MODULE_MERGE_SEP);
}

export function validateMergedModuleSegment(merged: string): string | null {
  const t = normalizePathSegmentValue(merged);
  if (!t) return '合并后的模块名为空';
  if (t.length > PATH_SEGMENT_MAX_LEN) {
    return `合并模块名过长（最多 ${PATH_SEGMENT_MAX_LEN} 个字符）`;
  }
  if (t.includes('&')) return '合并模块名不得包含「&」';
  if (PATH_SEGMENT_FORBIDDEN.test(t)) {
    return '合并模块名不得包含路径非法字符：/ \\ ? * : | " < >';
  }
  if (safePathSegment(t) !== t) {
    return '合并模块名含有无法用于飞书目录的字符';
  }
  return null;
}
