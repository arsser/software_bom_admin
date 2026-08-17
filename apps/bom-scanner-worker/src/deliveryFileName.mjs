/**
 * 飞书/本地交付文件名：默认用下载 URL basename。
 * 撞名（同名被另一份不同 MD5 占用）时改用组件 ID；仍撞则加毫秒时间戳。
 * 同名同 MD5 不算撞名（去重复用）。
 */

const COMPONENT_ID_KEYS = ['组件ID', 'componentId', 'component_id'];

function flatFilename(name) {
  const base = String(name ?? '').trim() || 'artifact.bin';
  const cleaned = base.replace(/[/\\?*:|"<>]/g, '_').replace(/\s+/g, ' ');
  return cleaned.slice(0, 220) || 'artifact.bin';
}

/**
 * @param {Record<string, unknown>} bomRow
 * @param {(row: Record<string, unknown>, keys: string[]) => unknown} pickFirstNonEmpty
 */
export function pickComponentId(bomRow, pickFirstNonEmpty) {
  if (!bomRow || typeof pickFirstNonEmpty !== 'function') return '';
  const v = pickFirstNonEmpty(bomRow, COMPONENT_ID_KEYS);
  return v != null ? String(v).trim() : '';
}

/**
 * @param {string} newStem
 * @param {string} originalName
 */
function attachOriginalExt(newStem, originalName) {
  const stem = flatFilename(newStem);
  const orig = flatFilename(originalName);
  const dot = orig.lastIndexOf('.');
  if (dot <= 0 || dot === orig.length - 1) return stem;
  const ext = orig.slice(dot);
  if (stem.toLowerCase().endsWith(ext.toLowerCase())) return stem;
  return flatFilename(stem + ext);
}

/**
 * 本地时区，精确到毫秒：20260818T020712.123
 * @param {Date} [d]
 */
export function formatDeliveryCollisionStamp(d = new Date()) {
  const p = (n, w) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1, 2)}${p(d.getDate(), 2)}T${p(d.getHours(), 2)}${p(d.getMinutes(), 2)}${p(d.getSeconds(), 2)}.${p(d.getMilliseconds(), 3)}`;
}

/**
 * @param {object} p
 * @param {string} p.baseName
 * @param {string} [p.componentId]
 * @param {string} [p.md5]
 * @param {(name: string, md5: string) => boolean | Promise<boolean>} p.isTakenByOther
 * @returns {Promise<string>}
 */
export async function resolveUniqueDeliveryFileName(p) {
  const md5 = String(p.md5 || '')
    .trim()
    .toLowerCase();
  const base = flatFilename(p.baseName || 'artifact.bin');
  const componentId = String(p.componentId || '').trim();
  const isTaken = async (name) => Boolean(await p.isTakenByOther(name, md5));

  if (!(await isTaken(base))) return base;

  if (componentId) {
    const idName = attachOriginalExt(componentId, base);
    if (idName && idName !== base && !(await isTaken(idName))) return idName;
  }

  const stem = componentId ? attachOriginalExt(componentId, base) : base;
  for (let i = 0; i < 40; i += 1) {
    const stamped = flatFilename(`${stem}_${formatDeliveryCollisionStamp(new Date())}`);
    if (!(await isTaken(stamped))) return stamped;
  }
  return flatFilename(`${stem}_${Date.now()}`);
}
