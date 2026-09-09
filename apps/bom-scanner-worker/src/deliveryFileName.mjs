/**
 * 飞书/本地交付文件名：默认用下载 URL basename。
 * 仅当「同一目标目录」里已被另一份不同 MD5 占用时改名：
 * 在原名加前缀【自动重命名1】、【自动重命名2】…
 * 同名同 MD5 不算撞名（去重复用）。
 */

const COMPONENT_ID_KEYS = ['组件ID', 'componentId', 'component_id'];

/** 全角括号、紧贴原名、无空格。捕获组为编号。 */
export const AUTO_RENAME_PREFIX_RE = /^【自动重命名(\d+)】/;

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
 * 去掉已有【自动重命名N】前缀，得到可还原的原名。
 * @param {string} fileName
 */
export function stripDeliveryAutoRenamePrefix(fileName) {
  const name = flatFilename(fileName);
  const m = name.match(AUTO_RENAME_PREFIX_RE);
  if (!m) return name;
  const rest = name.slice(m[0].length);
  return rest ? rest : name;
}

/**
 * @param {string} originalName 未加前缀的原名
 * @param {number} n >= 1
 */
export function applyDeliveryAutoRenamePrefix(originalName, n) {
  const original = stripDeliveryAutoRenamePrefix(originalName);
  const seq = Math.trunc(Number(n));
  const prefix = `【自动重命名${Number.isFinite(seq) && seq >= 1 ? seq : 1}】`;
  return flatFilename(`${prefix}${original}`);
}

/**
 * @param {object} p
 * @param {string} p.baseName
 * @param {string} [p.componentId] 保留参数以兼容旧调用，不再用于改名
 * @param {string} [p.md5]
 * @param {(name: string, md5: string) => boolean | Promise<boolean>} p.isTakenByOther
 * @returns {Promise<string>}
 */
export async function resolveUniqueDeliveryFileName(p) {
  const md5 = String(p.md5 || '')
    .trim()
    .toLowerCase();
  const original = stripDeliveryAutoRenamePrefix(p.baseName || 'artifact.bin');
  const isTaken = async (name) => Boolean(await p.isTakenByOther(name, md5));

  if (!(await isTaken(original))) return original;

  for (let n = 1; n <= 999; n += 1) {
    const candidate = applyDeliveryAutoRenamePrefix(original, n);
    if (!(await isTaken(candidate))) return candidate;
  }

  return applyDeliveryAutoRenamePrefix(original, Date.now());
}
