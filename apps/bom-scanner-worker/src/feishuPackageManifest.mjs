/**
 * 飞书产品根目录下 meta/package-manifest.json：软件包去重清单。
 * 约定：软件包文件名全局不重名；条目含相对路径、文件名、md5、大小、file_token、download_url。
 */

import { safeFlatFilename, safePathSegment } from './extArtifactorySync.mjs';

const META_DIR = 'meta';
const MANIFEST_FILE_NAME = 'package-manifest.json';
const MANIFEST_VERSION = 1;
const FEISHU_LIST_FOLDER_PAGE_SIZE = 50;
const FEISHU_SIZE_FETCH_GAP_MS = 280;
const FEISHU_SIZE_BACKOFF_MS = [700, 1400, 2800];

/**
 * 飞书开放平台文件下载 URL（需 Bearer token；仅供服务端 API 拉取，不可给浏览器直接打开）。
 * @param {string} fileToken
 */
export function buildFeishuFileDownloadUrl(fileToken) {
  const tok = safeTrim(fileToken);
  if (!tok) return '';
  return `https://open.feishu.cn/open-apis/drive/v1/files/${encodeURIComponent(tok)}/download`;
}

/**
 * 规范化企业飞书网页域名（如 https://xxx.feishu.cn）；拒绝 open.* 主机。
 * @param {unknown} raw
 */
export function normalizeFeishuWebBaseUrl(raw) {
  let s = String(raw ?? '')
    .trim()
    .replace(/\/+$/, '');
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    if (/^open\./i.test(u.hostname)) return '';
    return `${u.protocol}//${u.host}`;
  } catch {
    return '';
  }
}

/**
 * 飞书云空间文件网页链接（用户可分享、浏览器打开后预览/下载；需账号有权限）。
 * @param {string} fileToken
 * @param {string} [webBaseUrl]
 */
export function buildFeishuFileWebUrl(fileToken, webBaseUrl) {
  const tok = safeTrim(fileToken);
  const base = normalizeFeishuWebBaseUrl(webBaseUrl);
  if (!tok || !base) return '';
  return `${base}/file/${encodeURIComponent(tok)}`;
}

/**
 * 清单/表格展示用链接：优先企业网页链接；未配置域名时回退空（勿写 OpenAPI download）。
 * @param {string} fileToken
 * @param {string} [webBaseUrl]
 * @param {string} [existingUrl]
 */
export function resolvePackageManifestDownloadUrl(fileToken, webBaseUrl, existingUrl) {
  const web = buildFeishuFileWebUrl(fileToken, webBaseUrl);
  if (web) return web;
  const existing = safeTrim(existingUrl);
  if (existing && !/open\.feishu\.cn\/open-apis\//i.test(existing)) return existing;
  return '';
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function safeTrim(s) {
  return String(s ?? '').trim();
}

/**
 * @param {string} op
 * @param {number} httpStatus
 * @param {Record<string, unknown>} parsed
 * @param {string} [rawText]
 */
function feishuApiFailDetail(op, httpStatus, parsed, rawText) {
  const code = parsed && 'code' in parsed ? parsed.code : undefined;
  const msg = typeof parsed?.msg === 'string' ? parsed.msg : '';
  const pieces = [String(op), `HTTP ${httpStatus}`];
  if (code !== undefined && code !== null && code !== '') pieces.push(`飞书code=${String(code)}`);
  if (msg) pieces.push(`msg=${msg}`);
  if (rawText && (!msg || /^field validation failed$/i.test(msg.trim()))) {
    pieces.push(`raw=${String(rawText).slice(0, 400)}`);
  }
  return pieces.join(' · ');
}

/** @param {unknown} v */
function isValidMd5Hex(v) {
  return typeof v === 'string' && /^[a-f0-9]{32}$/i.test(v.trim());
}

/**
 * @typedef {{
 *   rel_path: string,
 *   file_name: string,
 *   md5: string,
 *   size_bytes: number,
 *   file_token: string,
 *   download_url: string,
 *   uploaded_at?: string,
 * }} FeishuPackageManifestEntry
 */

/**
 * @typedef {{
 *   version: number,
 *   updated_at: string,
 *   entries: FeishuPackageManifestEntry[],
 *   byFileName: Map<string, FeishuPackageManifestEntry>,
 *   byRelPath: Map<string, FeishuPackageManifestEntry>,
 *   dirty: boolean,
 *   fileToken: string | null,
 * }} FeishuPackageManifestState
 */

/**
 * @param {string} accessToken
 * @param {string} folderToken
 * @param {string} [pageToken]
 */
async function listFolderPage(accessToken, folderToken, pageToken) {
  const u = new URL('https://open.feishu.cn/open-apis/drive/v1/files');
  u.searchParams.set('folder_token', folderToken);
  u.searchParams.set('page_size', String(FEISHU_LIST_FOLDER_PAGE_SIZE));
  if (pageToken) u.searchParams.set('page_token', pageToken);
  const res = await fetch(u.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`列出文件夹响应非 JSON：${text.slice(0, 200)}`);
  }
  if (!res.ok || body.code !== 0) {
    throw new Error(feishuApiFailDetail('list_folder', res.status, body, text));
  }
  return {
    files: Array.isArray(body.data?.files) ? body.data.files : [],
    has_more: body.data?.has_more,
    page_token: body.data?.next_page_token,
  };
}

/**
 * @param {string} accessToken
 * @param {string} folderToken
 */
async function listAllInFolder(accessToken, folderToken) {
  const out = [];
  let pageToken;
  do {
    const page = await listFolderPage(accessToken, folderToken, pageToken);
    out.push(...page.files);
    pageToken = page.has_more && page.page_token ? page.page_token : undefined;
  } while (pageToken);
  return out;
}

/**
 * @param {Array<{ name?: string, token?: string, type?: string }>} items
 * @param {string} folderName
 */
function findChildFolderToken(items, folderName) {
  const want = safeTrim(folderName).normalize('NFKC');
  if (!want) return null;
  for (const it of items) {
    if (safeTrim(it.type) !== 'folder') continue;
    const n = safeTrim(it.name).normalize('NFKC');
    if (n === want) {
      const tok = safeTrim(it.token);
      if (tok) return tok;
    }
  }
  return null;
}

/**
 * @param {string} accessToken
 * @param {string} parentFolderToken
 * @param {string} name
 */
async function createDriveChildFolder(accessToken, parentFolderToken, name) {
  const res = await fetch('https://open.feishu.cn/open-apis/drive/v1/files/create_folder', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({ folder_token: parentFolderToken, name }),
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`创建文件夹响应非 JSON：${text.slice(0, 200)}`);
  }
  if (!res.ok || parsed.code !== 0) {
    throw new Error(feishuApiFailDetail('create_folder', res.status, parsed, text));
  }
  const token = parsed.data?.token;
  if (typeof token !== 'string' || !token.trim()) {
    throw new Error('创建成功但未返回子文件夹 token');
  }
  return token.trim();
}

/**
 * @param {string} accessToken
 * @param {string} rootFolderToken
 * @param {string[]} segmentNames
 */
async function ensureFolderPath(accessToken, rootFolderToken, segmentNames) {
  let cur = rootFolderToken;
  for (const seg of segmentNames) {
    if (!seg) continue;
    const items = await listAllInFolder(accessToken, cur);
    let next = findChildFolderToken(items, seg);
    if (!next) {
      next = await createDriveChildFolder(accessToken, cur, seg);
      log('feishu-manifest mkdir', { seg });
    }
    cur = next;
  }
  return cur;
}

/**
 * @param {string} accessToken
 * @param {string} fileToken
 * @param {string} [nodeType]
 */
async function deleteDriveFile(accessToken, fileToken, nodeType = 'file') {
  const u = new URL(`https://open.feishu.cn/open-apis/drive/v1/files/${encodeURIComponent(fileToken)}`);
  u.searchParams.set('type', nodeType === 'file' ? 'file' : nodeType || 'file');
  const res = await fetch(u.toString(), {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`删除文件响应非 JSON：${text.slice(0, 200)}`);
  }
  if (!res.ok || parsed.code !== 0) {
    throw new Error(feishuApiFailDetail('delete_file', res.status, parsed, text));
  }
}

/**
 * @param {string} accessToken
 * @param {string} fileToken
 */
async function downloadFileText(accessToken, fileToken) {
  const url = `https://open.feishu.cn/open-apis/drive/v1/files/${encodeURIComponent(fileToken)}/download`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`下载清单失败 HTTP ${res.status}：${text.slice(0, 300)}`);
  }
  return await res.text();
}

/**
 * @param {string} accessToken
 * @param {string} parentFolderToken
 * @param {string} fileName
 * @param {string} utf8Text
 */
async function uploadTextFile(accessToken, parentFolderToken, fileName, utf8Text) {
  const buf = Buffer.from(utf8Text, 'utf8');
  const form = new FormData();
  form.set('file_name', fileName);
  form.set('parent_type', 'explorer');
  form.set('parent_node', parentFolderToken);
  form.set('size', String(buf.length));
  form.set('file', new Blob([buf]), fileName);

  const res = await fetch('https://open.feishu.cn/open-apis/drive/v1/files/upload_all', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
    body: form,
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`upload_all 清单响应非 JSON：${text.slice(0, 300)}`);
  }
  if (!res.ok || parsed.code !== 0) {
    throw new Error(feishuApiFailDetail('upload_all(manifest)', res.status, parsed, text));
  }
  const fileToken = parsed.data?.file_token;
  if (typeof fileToken !== 'string' || !fileToken.trim()) {
    throw new Error('upload_all 清单成功但未返回 file_token');
  }
  return fileToken.trim();
}

/**
 * @param {string[]} pathSegments 相对产品根，如 [batchDir, middleDir]
 * @param {string} fileName
 */
export function buildFeishuPackageRelPath(pathSegments, fileName) {
  const base = safeFlatFilename(fileName).normalize('NFKC');
  const dirs = (pathSegments ?? [])
    .map((s) => safePathSegment(s))
    .filter(Boolean)
    .map((s) => s.normalize('NFKC'));
  return [...dirs, base].join('/');
}

/**
 * @param {unknown} raw
 * @param {string} [webBaseUrl]
 * @returns {FeishuPackageManifestEntry | null}
 */
function normalizeEntry(raw, webBaseUrl) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = /** @type {Record<string, unknown>} */ (raw);
  const fileName = safeFlatFilename(safeTrim(o.file_name || o.fileName)).normalize('NFKC');
  const md5 = isValidMd5Hex(o.md5) ? String(o.md5).trim().toLowerCase() : '';
  const sizeRaw = o.size_bytes ?? o.sizeBytes ?? o.size;
  const sizeBytes = typeof sizeRaw === 'string' ? Number(sizeRaw) : Number(sizeRaw);
  const fileToken = safeTrim(o.file_token || o.fileToken);
  let relPath = safeTrim(o.rel_path || o.relPath).replace(/\\/g, '/').replace(/^\/+/, '').normalize('NFKC');
  // 可视化扫描可保留无 md5 的条目；去重命中仍要求合法 md5
  if (!fileName || !Number.isFinite(sizeBytes) || sizeBytes < 0 || !fileToken) return null;
  if (!relPath) relPath = fileName;
  const downloadUrlRaw = safeTrim(o.download_url || o.downloadUrl);
  return {
    rel_path: relPath,
    file_name: fileName,
    md5,
    size_bytes: Math.trunc(sizeBytes),
    file_token: fileToken,
    download_url: resolvePackageManifestDownloadUrl(fileToken, webBaseUrl, downloadUrlRaw),
    uploaded_at:
      typeof o.uploaded_at === 'string'
        ? o.uploaded_at
        : typeof o.uploadedAt === 'string'
          ? o.uploadedAt
          : undefined,
  };
}

/**
 * @param {string} [jsonText]
 * @param {string} [webBaseUrl]
 * @returns {FeishuPackageManifestState}
 */
export function createEmptyPackageManifest(jsonText, webBaseUrl) {
  /** @type {FeishuPackageManifestEntry[]} */
  const entries = [];
  if (jsonText && jsonText.trim()) {
    try {
      const parsed = JSON.parse(jsonText);
      const list = Array.isArray(parsed?.entries)
        ? parsed.entries
        : Array.isArray(parsed?.files)
          ? parsed.files
          : Array.isArray(parsed)
            ? parsed
            : [];
      for (const item of list) {
        const e = normalizeEntry(item, webBaseUrl);
        if (e) entries.push(e);
      }
    } catch (err) {
      log('WARN feishu-manifest parse failed, start empty', err instanceof Error ? err.message : err);
    }
  }

  /** @type {Map<string, FeishuPackageManifestEntry>} */
  const byFileName = new Map();
  /** @type {Map<string, FeishuPackageManifestEntry>} */
  const byRelPath = new Map();
  for (const e of entries) {
    byFileName.set(e.file_name, e);
    byRelPath.set(e.rel_path, e);
  }

  return {
    version: MANIFEST_VERSION,
    updated_at: new Date().toISOString(),
    entries: [...byFileName.values()],
    byFileName,
    byRelPath,
    dirty: false,
    fileToken: null,
  };
}

/**
 * 从产品飞书根加载 meta/package-manifest.json；不存在则返回空清单。
 * @param {string} accessToken
 * @param {string} rootFolderToken
 * @returns {Promise<FeishuPackageManifestState>}
 */
export async function loadFeishuPackageManifest(accessToken, rootFolderToken) {
  const rootItems = await listAllInFolder(accessToken, rootFolderToken);
  const metaToken = findChildFolderToken(rootItems, META_DIR);
  if (!metaToken) {
    log('feishu-manifest meta folder missing, empty inventory');
    return createEmptyPackageManifest();
  }

  const metaItems = await listAllInFolder(accessToken, metaToken);
  const want = MANIFEST_FILE_NAME.normalize('NFKC');
  /** @type {{ token: string } | null} */
  let found = null;
  for (const it of metaItems) {
    if (safeTrim(it.type) !== 'file') continue;
    const n = safeFlatFilename(safeTrim(it.name)).normalize('NFKC');
    if (n === want && it.token) {
      found = { token: safeTrim(it.token) };
      break;
    }
  }
  if (!found) {
    log('feishu-manifest file missing, empty inventory');
    return createEmptyPackageManifest();
  }

  try {
    const text = await downloadFileText(accessToken, found.token);
    const state = createEmptyPackageManifest(text);
    state.fileToken = found.token;
    log('feishu-manifest loaded', { entries: state.byFileName.size });
    return state;
  } catch (err) {
    log('WARN feishu-manifest download failed, empty inventory', err instanceof Error ? err.message : err);
    return createEmptyPackageManifest();
  }
}

/**
 * @param {FeishuPackageManifestState} state
 * @param {{ fileName: string, md5: string, sizeBytes: number, relPath?: string }} q
 * @returns {FeishuPackageManifestEntry | null}
 */
export function findPackageManifestHit(state, q) {
  const fileName = safeFlatFilename(q.fileName).normalize('NFKC');
  const md5 = isValidMd5Hex(q.md5) ? String(q.md5).trim().toLowerCase() : '';
  const sizeBytes = Math.trunc(Number(q.sizeBytes));
  if (!fileName || !md5 || !Number.isFinite(sizeBytes) || sizeBytes < 0) return null;

  const byName = state.byFileName.get(fileName);
  if (byName && byName.md5 && byName.md5 === md5 && byName.size_bytes === sizeBytes) {
    return byName;
  }

  const relPath = q.relPath
    ? safeTrim(q.relPath).replace(/\\/g, '/').replace(/^\/+/, '').normalize('NFKC')
    : '';
  if (relPath) {
    const byPath = state.byRelPath.get(relPath);
    if (byPath && byPath.md5 && byPath.md5 === md5 && byPath.size_bytes === sizeBytes) {
      return byPath;
    }
  }
  return null;
}

/**
 * @param {FeishuPackageManifestState} state
 * @param {{ relPath: string, fileName: string, md5: string, sizeBytes: number, fileToken: string, webBaseUrl?: string }} p
 */
export function upsertPackageManifestEntry(state, p) {
  const fileName = safeFlatFilename(p.fileName).normalize('NFKC');
  const md5 = String(p.md5).trim().toLowerCase();
  const relPath = safeTrim(p.relPath).replace(/\\/g, '/').replace(/^\/+/, '').normalize('NFKC');
  const sizeBytes = Math.trunc(Number(p.sizeBytes));
  const fileToken = safeTrim(p.fileToken);
  if (!fileName || !isValidMd5Hex(md5) || !relPath || !fileToken || !Number.isFinite(sizeBytes) || sizeBytes < 0) {
    return;
  }

  const prev = state.byFileName.get(fileName);
  if (prev && prev.rel_path !== relPath) {
    state.byRelPath.delete(prev.rel_path);
  }

  /** @type {FeishuPackageManifestEntry} */
  const entry = {
    rel_path: relPath,
    file_name: fileName,
    md5,
    size_bytes: sizeBytes,
    file_token: fileToken,
    download_url: resolvePackageManifestDownloadUrl(fileToken, p.webBaseUrl),
    uploaded_at: new Date().toISOString(),
  };
  state.byFileName.set(fileName, entry);
  state.byRelPath.set(relPath, entry);
  state.entries = [...state.byFileName.values()];
  state.dirty = true;
  state.updated_at = entry.uploaded_at;
}

/**
 * 若 dirty，覆盖写回 meta/package-manifest.json。
 * @param {string} accessToken
 * @param {string} rootFolderToken
 * @param {FeishuPackageManifestState} state
 */
export async function saveFeishuPackageManifestIfDirty(accessToken, rootFolderToken, state) {
  if (!state.dirty) return false;

  const metaToken = await ensureFolderPath(accessToken, rootFolderToken, [META_DIR]);
  const metaItems = await listAllInFolder(accessToken, metaToken);
  const want = MANIFEST_FILE_NAME.normalize('NFKC');
  for (const it of metaItems) {
    if (safeTrim(it.type) !== 'file') continue;
    const n = safeFlatFilename(safeTrim(it.name)).normalize('NFKC');
    if (n === want && it.token) {
      try {
        await deleteDriveFile(accessToken, safeTrim(it.token), 'file');
      } catch (err) {
        log('WARN feishu-manifest delete old failed', err instanceof Error ? err.message : err);
      }
      break;
    }
  }

  const payload = {
    version: MANIFEST_VERSION,
    updated_at: state.updated_at || new Date().toISOString(),
    entries: [...state.byFileName.values()].sort((a, b) => a.rel_path.localeCompare(b.rel_path)),
  };
  const text = `${JSON.stringify(payload, null, 2)}\n`;
  const fileToken = await uploadTextFile(accessToken, metaToken, MANIFEST_FILE_NAME, text);
  state.fileToken = fileToken;
  state.dirty = false;
  log('feishu-manifest saved', { entries: payload.entries.length, fileToken: fileToken.slice(0, 12) });
  return true;
}

/**
 * @param {string} accessToken
 * @param {string} fileToken
 * @returns {Promise<number | null>}
 */
async function fetchDriveBinaryFileSize(accessToken, fileToken) {
  const url = buildFeishuFileDownloadUrl(fileToken);
  const auth = { Authorization: `Bearer ${accessToken}` };

  for (let attempt = 0; attempt < FEISHU_SIZE_BACKOFF_MS.length; attempt++) {
    try {
      const headRes = await fetch(url, { method: 'HEAD', headers: auth });
      if (headRes.ok) {
        const cl = headRes.headers.get('content-length');
        if (cl) {
          const n = parseInt(cl, 10);
          if (Number.isFinite(n) && n >= 0) return n;
        }
      } else if (headRes.status === 429) {
        await sleep(FEISHU_SIZE_BACKOFF_MS[attempt] ?? 1000);
        continue;
      }
    } catch {
      /* ignore */
    }

    await sleep(120);
    try {
      const res = await fetch(url, { method: 'GET', headers: { ...auth, Range: 'bytes=0-0' } });
      if (res.status === 429) {
        await sleep(FEISHU_SIZE_BACKOFF_MS[attempt] ?? 1000);
        continue;
      }
      const cr = res.headers.get('content-range');
      if (cr) {
        const m = cr.match(/\/(\d+)\s*$/);
        if (m) {
          const n = Number(m[1]);
          if (Number.isFinite(n) && n >= 0) return n;
        }
      }
      if (res.ok) {
        const cl = res.headers.get('content-length');
        if (cl) {
          const n = parseInt(cl, 10);
          if (Number.isFinite(n) && n > 0) return n;
        }
      }
    } catch {
      /* ignore */
    }
  }
  return null;
}

/**
 * 遍历产品根下全部文件（跳过根下 meta/）。
 * @param {string} accessToken
 * @param {string} folderToken
 * @param {string} prefix
 * @param {Array<{ relPath: string, fileName: string, fileToken: string }>} out
 * @param {{ skipMetaAtRoot?: boolean }} [opts]
 */
async function walkDriveFiles(accessToken, folderToken, prefix, out, opts = {}) {
  const items = await listAllInFolder(accessToken, folderToken);
  for (const it of items) {
    const name = safeTrim(it?.name);
    if (!name) continue;
    const t = safeTrim(it?.type);
    if (t === 'folder') {
      if (opts.skipMetaAtRoot && !prefix && name.normalize('NFKC') === META_DIR) continue;
      const childToken = safeTrim(it?.token);
      if (!childToken) continue;
      const nextPrefix = prefix ? `${prefix}${name}/` : `${name}/`;
      await walkDriveFiles(accessToken, childToken, nextPrefix, out, { skipMetaAtRoot: false });
      continue;
    }
    if (t !== 'file') continue;
    const fileTok = safeTrim(it?.token);
    if (!fileTok) continue;
    const fileName = safeFlatFilename(name).normalize('NFKC');
    const relPath = `${prefix}${fileName}`.normalize('NFKC');
    out.push({ relPath, fileName, fileToken: fileTok });
  }
}

/**
 * 扫描产品飞书根目录并重建 package-manifest.json。
 * md5 优先取自 localByFileName，其次沿用旧清单同名/同 token 条目。
 *
 * @param {string} accessToken
 * @param {string} rootFolderToken
 * @param {{
 *   localByFileName?: Map<string, { md5: string, sizeBytes: number }>,
 *   webBaseUrl?: string,
 *   onProgress?: (info: { scanned: number, total: number, message: string }) => void | Promise<void>,
 * }} [opts]
 * @returns {Promise<{ state: FeishuPackageManifestState, filesFound: number, withMd5: number, withoutMd5: number }>}
 */
export async function rebuildFeishuPackageManifestFromDrive(accessToken, rootFolderToken, opts = {}) {
  const localByFileName = opts.localByFileName instanceof Map ? opts.localByFileName : new Map();
  const webBaseUrl = normalizeFeishuWebBaseUrl(opts.webBaseUrl);
  const prev = await loadFeishuPackageManifest(accessToken, rootFolderToken);

  /** @type {Array<{ relPath: string, fileName: string, fileToken: string }>} */
  const files = [];
  await walkDriveFiles(accessToken, rootFolderToken, '', files, { skipMetaAtRoot: true });

  const next = createEmptyPackageManifest();
  let withMd5 = 0;
  let withoutMd5 = 0;

  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (opts.onProgress) {
      await opts.onProgress({
        scanned: i,
        total: files.length,
        message: `扫描文件 ${i + 1}/${files.length}：${f.fileName}`,
      });
    }

    const local = localByFileName.get(f.fileName);
    const oldByName = prev.byFileName.get(f.fileName);
    const oldByPath = prev.byRelPath.get(f.relPath);
    const old =
      oldByName && oldByName.file_token === f.fileToken
        ? oldByName
        : oldByPath && oldByPath.file_token === f.fileToken
          ? oldByPath
          : oldByName || oldByPath || null;

    let sizeBytes = local && Number.isFinite(local.sizeBytes) ? Math.trunc(local.sizeBytes) : null;
    if (sizeBytes == null && old && Number.isFinite(old.size_bytes)) sizeBytes = old.size_bytes;
    if (sizeBytes == null) {
      const sz = await fetchDriveBinaryFileSize(accessToken, f.fileToken);
      if (sz != null) sizeBytes = sz;
      if (i < files.length - 1) await sleep(FEISHU_SIZE_FETCH_GAP_MS);
    }
    if (sizeBytes == null || sizeBytes < 0) sizeBytes = 0;

    let md5 = '';
    if (local && isValidMd5Hex(local.md5)) md5 = String(local.md5).trim().toLowerCase();
    else if (old && isValidMd5Hex(old.md5)) md5 = old.md5;

    if (md5) withMd5 += 1;
    else withoutMd5 += 1;

    /** @type {FeishuPackageManifestEntry} */
    const entry = {
      rel_path: f.relPath,
      file_name: f.fileName,
      md5,
      size_bytes: sizeBytes,
      file_token: f.fileToken,
      download_url: resolvePackageManifestDownloadUrl(f.fileToken, webBaseUrl, old?.download_url),
      uploaded_at: old?.uploaded_at || new Date().toISOString(),
    };
    next.byFileName.set(entry.file_name, entry);
    next.byRelPath.set(entry.rel_path, entry);
  }

  next.entries = [...next.byFileName.values()];
  next.dirty = true;
  next.updated_at = new Date().toISOString();

  if (opts.onProgress) {
    await opts.onProgress({
      scanned: files.length,
      total: files.length,
      message: `写回清单（${next.entries.length} 条）…`,
    });
  }
  await saveFeishuPackageManifestIfDirty(accessToken, rootFolderToken, next);

  return { state: next, filesFound: files.length, withMd5, withoutMd5 };
}

/**
 * 将清单序列化为可展示的纯 JSON（无 Map）。
 * @param {FeishuPackageManifestState} state
 */
export function packageManifestToJson(state) {
  return {
    version: state.version || MANIFEST_VERSION,
    updated_at: state.updated_at || null,
    entries: [...state.byFileName.values()].sort((a, b) => a.rel_path.localeCompare(b.rel_path)),
  };
}
