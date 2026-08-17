/**
 * 本地暂存路径约定（目录方案 C）：
 *   {BOM_LOCAL_ROOT}/{batchDir}/{middleDir?}/{originalFileName}
 * 同 MD5 跨版本用硬链复用；交付名默认 URL basename。
 * 同目录撞名（另一份不同 MD5）时改用组件 ID，再撞则加毫秒时间戳。
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import { safeFlatFilename, safePathSegment } from './extArtifactorySync.mjs';

/**
 * @param {string} urlOrPath
 */
export function urlPathBasename(urlOrPath) {
  const raw = String(urlOrPath ?? '').trim();
  if (!raw) return 'artifact.bin';
  try {
    if (/^https?:\/\//i.test(raw)) {
      const u = new URL(raw);
      const seg = u.pathname.split('/').filter(Boolean);
      if (seg.length) return decodeURIComponent(seg[seg.length - 1]);
    }
  } catch {
    /* fall through */
  }
  const parts = raw.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.length ? decodeURIComponent(parts[parts.length - 1]) : 'artifact.bin';
}

/**
 * 交付用原始文件名（来自下载 URL / 路径），不做 _N 撞名改写。
 * @param {string} urlOrPath
 */
export function deliveryFileNameFromUrl(urlOrPath) {
  return safeFlatFilename(urlPathBasename(urlOrPath));
}

/**
 * @param {string} batchDir already safePathSegment'd
 * @param {string | null | undefined} middleDir
 * @param {string} fileName
 */
export function buildVersionRelativePath(batchDir, middleDir, fileName) {
  const batch = safePathSegment(batchDir);
  const file = safeFlatFilename(fileName);
  const mid = middleDir ? safePathSegment(middleDir) : null;
  return mid ? [batch, mid, file].join('/') : [batch, file].join('/');
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} md5Lower
 * @returns {Promise<string | null>} relative path that still exists on disk (caller checks root)
 */
export async function findExistingLocalRelPathByMd5(supabase, md5Lower) {
  const md5 = String(md5Lower || '').trim().toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(md5)) return null;
  const { data, error } = await supabase
    .from('local_file')
    .select('path')
    .eq('md5', md5)
    .order('updated_at', { ascending: false })
    .limit(20);
  if (error) throw error;
  const rows = Array.isArray(data) ? data : [];
  for (const r of rows) {
    const p = typeof r?.path === 'string' ? r.path.trim() : '';
    if (p) return p;
  }
  return null;
}

/**
 * 若期望 MD5 已在索引中且源文件存在，则在 destRel 处硬链；已存在且同 inode/同内容则复用。
 * @param {object} p
 * @param {string} p.rootAbs
 * @param {string} p.destRel 目标相对路径
 * @param {string} p.sourceRel 已有相对路径
 * @returns {Promise<{ ok: true, kind: 'already' | 'hardlink' | 'copied' } | { ok: false, message: string }>}
 */
export async function linkOrReuseLocalPath(p) {
  const { rootAbs, destRel, sourceRel } = p;
  const destAbs = path.join(rootAbs, destRel.split('/').join(path.sep));
  const sourceAbs = path.join(rootAbs, sourceRel.split('/').join(path.sep));

  if (path.resolve(destAbs) === path.resolve(sourceAbs)) {
    return { ok: true, kind: 'already' };
  }

  let sourceStat;
  try {
    sourceStat = await fs.stat(sourceAbs);
    if (!sourceStat.isFile()) return { ok: false, message: `硬链源不是文件：${sourceRel}` };
  } catch {
    return { ok: false, message: `硬链源不存在：${sourceRel}` };
  }

  try {
    const destStat = await fs.stat(destAbs);
    if (destStat.isFile()) {
      if (destStat.ino === sourceStat.ino && destStat.dev === sourceStat.dev) {
        return { ok: true, kind: 'already' };
      }
      return {
        ok: false,
        message: `目标路径已存在且与源不是同一文件：${destRel}（请手工处理冲突后再试）`,
      };
    }
  } catch {
    /* dest missing — create */
  }

  await fs.mkdir(path.dirname(destAbs), { recursive: true });
  try {
    await fs.link(sourceAbs, destAbs);
    return { ok: true, kind: 'hardlink' };
  } catch (e) {
    const code = e && typeof e === 'object' && 'code' in e ? String(/** @type {{ code?: string }} */ (e).code) : '';
    if (code === 'EEXIST') {
      return { ok: true, kind: 'already' };
    }
    // 跨设备等：退回复制，保证功能可用（跨机拷贝完整性场景仍是实文件）
    if (code === 'EXDEV' || code === 'EPERM') {
      await fs.copyFile(sourceAbs, destAbs);
      return { ok: true, kind: 'copied' };
    }
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, message: `硬链失败：${msg}` };
  }
}
