import path from 'node:path';
import fs from 'node:fs/promises';
import {
  fetchBomScannerValue,
  fetchBatchProductDistributionSettings,
  findLocalPathForMd5,
  mergeKeyMap,
  firstNonEmptyByKeysRelaxed,
  safeFlatFilename,
  safePathSegment,
} from './extArtifactorySync.mjs';
import {
  patchBomRowFeishuAfterUpload,
  patchBomRowFeishuUploadError,
  extractFeishuMultipartState,
  saveBomRowFeishuMultipartState,
  clearBomRowFeishuMultipartState,
} from './bomRowStatusJson.mjs';
import { reportBomLocalRootRuntime } from './workerRuntimeReport.mjs';

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

/**
 * 提取错误对象的可诊断细节（含 cause 链），便于定位网络层问题（如 ECONNRESET / ENOTFOUND）。
 * @param {unknown} err
 */
function extractErrorDetail(err) {
  /** @type {Array<Record<string, unknown>>} */
  const chain = [];
  /** @type {unknown} */
  let cur = err;
  for (let i = 0; i < 4 && cur && typeof cur === 'object'; i += 1) {
    const o = /** @type {Record<string, unknown>} */ (cur);
    const one = {};
    if (typeof o.name === 'string' && o.name) one.name = o.name;
    if (typeof o.message === 'string' && o.message) one.message = o.message;
    if (typeof o.code === 'string' && o.code) one.code = o.code;
    if (typeof o.errno === 'number') one.errno = o.errno;
    if (typeof o.syscall === 'string' && o.syscall) one.syscall = o.syscall;
    if (typeof o.hostname === 'string' && o.hostname) one.hostname = o.hostname;
    if (typeof o.address === 'string' && o.address) one.address = o.address;
    if (typeof o.port === 'number') one.port = o.port;
    if (Object.keys(one).length > 0) chain.push(one);
    cur = o.cause;
  }
  return chain;
}

const FEISHU_UPLOAD_ALL_MAX_BYTES = 5 * 1024 * 1024;
const FEISHU_UPLOAD_ID_TTL_MS = 23 * 60 * 60 * 1000;
const FEISHU_PART_RETRY_MAX = 2;
const FEISHU_PART_DELAY_MS = 220;
const FEISHU_TOKEN_REFRESH_MS = 100 * 60 * 1000;
const FEISHU_TOKEN_SAFETY_BUFFER_MS = 10 * 60 * 1000;

/**
 * 飞书常见 token 失效英文提示（如 code 99991663 / 99991668 等对应 msg）。
 * @param {string} message
 */
function isFeishuInvalidAccessTokenMessage(message) {
  const m = String(message ?? '').toLowerCase();
  if (!m) return false;
  return (
    m.includes('invalid access token') ||
    m.includes('token attached') ||
    m.includes('access token invalid') ||
    m.includes('99991663') ||
    m.includes('99991668')
  );
}

function safeTrim(s) {
  return String(s ?? '').trim();
}

/** @param {unknown} v */
function isValidMd5Hex(v) {
  return typeof v === 'string' && /^[a-f0-9]{32}$/i.test(v.trim());
}

/**
 * @param {Record<string, unknown>} bomRow
 * @param {ReturnType<typeof mergeKeyMap>} keyMap
 */
function extractExpectedMd5Lower(bomRow, keyMap) {
  const md5Raw = firstNonEmptyByKeysRelaxed(bomRow, keyMap.expectedMd5);
  const lower = md5Raw && isValidMd5Hex(md5Raw) ? md5Raw.trim().toLowerCase() : null;
  return lower;
}

/**
 * @param {Record<string, unknown>} bomRow
 * @param {ReturnType<typeof mergeKeyMap>} keyMap
 */
function resolveMiddleDirFromRow(bomRow, keyMap) {
  const mod = firstNonEmptyByKeysRelaxed(bomRow, keyMap.moduleName);
  if (mod) return safePathSegment(mod);
  const grp = firstNonEmptyByKeysRelaxed(bomRow, keyMap.groupSegment);
  if (grp) return safePathSegment(grp);
  return null;
}

function basenameFromStoragePath(p) {
  const t = String(p ?? '').trim().replace(/\\/g, '/');
  const parts = t.split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 */
async function loadFeishuAppCreds(supabase) {
  const envId = safeTrim(process.env.FEISHU_APP_ID);
  const envSecret = safeTrim(process.env.FEISHU_APP_SECRET);
  if (envId && envSecret) return { appId: envId, appSecret: envSecret };
  const { data, error } = await supabase.from('system_settings').select('value').eq('key', 'feishu_config').maybeSingle();
  if (error) {
    log('WARN load feishu_config', error.message);
    return { appId: '', appSecret: '' };
  }
  const v = (data?.value ?? {}) instanceof Object ? /** @type {Record<string, unknown>} */ (data.value) : {};
  return {
    appId: typeof v.appId === 'string' ? v.appId.trim() : '',
    appSecret: typeof v.appSecret === 'string' ? String(v.appSecret).trim() : '',
  };
}

/**
 * @returns {Promise<{ token: string, expireSec: number }>}
 */
async function feishuTenantToken(appId, appSecret) {
  const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`飞书 token 响应非 JSON：${text.slice(0, 200)}`);
  }
  if (!res.ok || body.code !== 0 || !body.tenant_access_token) {
    throw new Error(body.msg || `获取 tenant_access_token 失败 HTTP ${res.status}`);
  }
  const expireSec = Number.isFinite(body.expire) && body.expire > 0 ? Number(body.expire) : 7200;
  return { token: String(body.tenant_access_token), expireSec };
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} jobId
 * @param {Record<string, unknown>} patch
 */
async function patchFeishuUploadJob(supabase, jobId, patch) {
  const { error } = await supabase.from('bom_feishu_upload_jobs').update(patch).eq('id', jobId);
  if (error) log('WARN patchFeishuUploadJob', jobId, error.message);
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} jobId
 */
async function isFeishuUploadJobCancelRequested(supabase, jobId) {
  const { data, error } = await supabase
    .from('bom_feishu_upload_jobs')
    .select('cancel_requested')
    .eq('id', jobId)
    .maybeSingle();
  if (error) {
    log('WARN feishu cancel_requested read', error.message);
    return false;
  }
  return Boolean(data?.cancel_requested);
}

/**
 * @typedef {{ name?: string; token?: string; type?: string }} FeishuListFile
 */

/**
 * @param {string} accessToken
 * @param {string} folderToken
 * @param {string} [pageToken]
 */
async function listFolderPage(accessToken, folderToken, pageToken) {
  const u = new URL('https://open.feishu.cn/open-apis/drive/v1/files');
  u.searchParams.set('folder_token', folderToken);
  u.searchParams.set('page_size', '200');
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
    throw new Error(body.msg || `列出文件夹失败 HTTP ${res.status}`);
  }
  const files = Array.isArray(body.data?.files) ? body.data.files : [];
  return {
    files,
    has_more: body.data?.has_more,
    page_token: body.data?.next_page_token,
  };
}

/**
 * @param {string} accessToken
 * @param {string} folderToken
 * @returns {Promise<FeishuListFile[]>}
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
 * @param {FeishuListFile[]} items
 * @param {string} folderName
 */
function findChildFolderToken(items, folderName) {
  for (const it of items) {
    if (safeTrim(it.type) !== 'folder') continue;
    if (safeTrim(it.name) === folderName) {
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
    const base = parsed.msg || `创建文件夹失败 HTTP ${res.status}`;
    const parts = [base];
    if (typeof parsed.code === 'number') parts.push(`飞书错误码 ${parsed.code}`);
    throw new Error(parts.join(' · '));
  }
  const token = parsed.data?.token;
  if (typeof token !== 'string' || !token.trim()) {
    throw new Error('创建成功但未返回子文件夹 token');
  }
  return { token: token.trim() };
}

/**
 * 在 parent 下逐级确保文件夹存在（与飞书扫描 / ext 路径一致）
 * @param {string} accessToken
 * @param {string} rootFolderToken
 * @param {string[]} segmentNames 例如 ['3.122','MyGroup']
 */
async function ensureFolderPath(accessToken, rootFolderToken, segmentNames) {
  let cur = rootFolderToken;
  for (const seg of segmentNames) {
    if (!seg) continue;
    const items = await listAllInFolder(accessToken, cur);
    let next = findChildFolderToken(items, seg);
    if (!next) {
      const created = await createDriveChildFolder(accessToken, cur, seg);
      next = created.token;
      log('feishu-upload mkdir', { parent: cur.slice(0, 12), seg });
    }
    cur = next;
  }
  return cur;
}

/**
 * @param {string} accessToken
 * @param {string} fileToken
 */
async function deleteDriveFile(accessToken, fileToken) {
  const res = await fetch(`https://open.feishu.cn/open-apis/drive/v1/files/${encodeURIComponent(fileToken)}`, {
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
    throw new Error(parsed.msg || `删除飞书文件失败 HTTP ${res.status}`);
  }
}

/**
 * 若父目录下已有同名文件则删除（便于覆盖上传）
 * @param {string} accessToken
 * @param {string} parentToken
 * @param {string} wantFileName
 */
async function removeSameNameFileIfAny(accessToken, parentToken, wantFileName) {
  const items = await listAllInFolder(accessToken, parentToken);
  const want = safeFlatFilename(wantFileName).normalize('NFKC');
  for (const it of items) {
    if (safeTrim(it.type) !== 'file') continue;
    const n = safeFlatFilename(safeTrim(it.name)).normalize('NFKC');
    if (n === want && it.token) {
      await deleteDriveFile(accessToken, safeTrim(it.token));
      log('feishu-upload removed existing file', wantFileName);
      break;
    }
  }
}

/**
 * @param {string} accessToken
 * @param {string} parentFolderToken
 * @param {string} localAbsPath
 * @param {string} fileName
 */
async function uploadAllUnderFolder(accessToken, parentFolderToken, localAbsPath, fileName) {
  const buf = await fs.readFile(localAbsPath);
  if (buf.length === 0) throw new Error('空文件不可上传飞书');
  if (buf.length > FEISHU_UPLOAD_ALL_MAX_BYTES) {
    throw new Error(
      `文件 ${buf.length} B 超过飞书 upload_all 上限 ${FEISHU_UPLOAD_ALL_MAX_BYTES} B（20MB），请改分片上传或缩小文件`,
    );
  }
  const blob = new Blob([buf]);
  const form = new FormData();
  form.set('file_name', fileName);
  form.set('parent_type', 'explorer');
  form.set('parent_node', parentFolderToken);
  form.set('size', String(buf.length));
  form.set('file', blob, fileName);

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
    throw new Error(`upload_all 响应非 JSON：${text.slice(0, 300)}`);
  }
  if (!res.ok || parsed.code !== 0) {
    throw new Error(parsed.msg || `upload_all 失败 HTTP ${res.status}`);
  }
  const fileToken = parsed.data?.file_token;
  if (typeof fileToken !== 'string' || !fileToken.trim()) {
    throw new Error('upload_all 成功但未返回 file_token');
  }
  return { fileToken: fileToken.trim(), sizeBytes: buf.length };
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)}GB`;
}

/**
 * @param {number} seconds
 */
function formatEtaSeconds(seconds) {
  const sec = Math.max(0, Math.ceil(seconds));
  if (sec < 60) return `${sec}秒`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  if (min < 60) return remSec > 0 ? `${min}分${remSec}秒` : `${min}分`;
  const hour = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin > 0 ? `${hour}时${remMin}分` : `${hour}时`;
}

/**
 * tenant_access_token 管理器。
 * - 按飞书服务端返回的 `expire` 字段动态决定下一次刷新时机（留 10 分钟安全余量，且不超过 100 分钟）。
 * - 并发下去重刷新（single-flight）。
 * - 暴露 stats()，便于外部在每一行上传前打诊断日志。
 *
 * @returns {{
 *   getAccessToken: () => Promise<string>,
 *   invalidate: (reason?: string) => void,
 *   stats: () => { hasToken: boolean, ageSec: number|null, remainingSec: number|null, refreshCount: number },
 * }}
 */
function createFeishuTokenManager(appId, appSecret) {
  /** @type {string | null} */
  let token = null;
  let obtainedAt = 0;
  /** token 的服务端有效期（毫秒） */
  let expireMs = 0;
  let refreshCount = 0;
  /** @type {Promise<string> | null} */
  let refreshInFlight = null;

  function computeRefreshAfterMs() {
    const ttl = Math.max(0, expireMs - FEISHU_TOKEN_SAFETY_BUFFER_MS);
    return Math.min(ttl, FEISHU_TOKEN_REFRESH_MS);
  }

  function isStale() {
    if (!token) return true;
    const age = Date.now() - obtainedAt;
    return age >= computeRefreshAfterMs();
  }

  async function refreshLocked() {
    const isRefresh = Boolean(token);
    const prevAgeSec = token ? Math.round((Date.now() - obtainedAt) / 1000) : null;
    const prevRemainingSec = token ? Math.round((obtainedAt + expireMs - Date.now()) / 1000) : null;
    const { token: newToken, expireSec } = await feishuTenantToken(appId, appSecret);
    token = newToken;
    obtainedAt = Date.now();
    expireMs = expireSec * 1000;
    refreshCount += 1;
    log('feishu token obtained', {
      kind: isRefresh ? 'refresh' : 'initial',
      refreshCount,
      prevAgeSec,
      prevRemainingSec,
      expireSec,
      refreshAfterSec: Math.round(computeRefreshAfterMs() / 1000),
      tokenTail: newToken.slice(-6),
    });
    return newToken;
  }

  return {
    async getAccessToken() {
      if (isStale()) {
        if (!refreshInFlight) {
          refreshInFlight = refreshLocked().finally(() => {
            refreshInFlight = null;
          });
        }
        await refreshInFlight;
      }
      return /** @type {string} */ (token);
    },
    invalidate(reason) {
      if (token) {
        log('feishu token invalidated', {
          reason: reason || 'unspecified',
          ageSec: Math.round((Date.now() - obtainedAt) / 1000),
          remainingSec: Math.round((obtainedAt + expireMs - Date.now()) / 1000),
          tokenTail: token.slice(-6),
        });
      }
      token = null;
      obtainedAt = 0;
      expireMs = 0;
    },
    stats() {
      const now = Date.now();
      return {
        hasToken: Boolean(token),
        ageSec: token ? Math.round((now - obtainedAt) / 1000) : null,
        remainingSec: token ? Math.round((obtainedAt + expireMs - now) / 1000) : null,
        refreshCount,
      };
    },
  };
}

/**
 * @param {string} accessToken
 * @param {string} parentFolderToken
 * @param {string} fileName
 * @param {number} fileSize
 */
async function uploadPrepare(accessToken, parentFolderToken, fileName, fileSize) {
  const res = await fetch('https://open.feishu.cn/open-apis/drive/v1/files/upload_prepare', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      file_name: fileName,
      parent_type: 'explorer',
      parent_node: parentFolderToken,
      size: fileSize,
    }),
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`upload_prepare 响应非 JSON：${text.slice(0, 300)}`);
  }
  if (!res.ok || parsed.code !== 0) {
    throw new Error(parsed.msg || `upload_prepare 失败 HTTP ${res.status} code=${parsed.code}`);
  }
  return {
    uploadId: String(parsed.data.upload_id),
    blockSize: Number(parsed.data.block_size),
    blockNum: Number(parsed.data.block_num),
  };
}

/**
 * @param {string} accessToken
 * @param {string} uploadId
 * @param {number} seq
 * @param {Buffer} chunkBuffer
 */
async function uploadPart(accessToken, uploadId, seq, chunkBuffer) {
  const form = new FormData();
  form.set('upload_id', uploadId);
  form.set('seq', String(seq));
  form.set('size', String(chunkBuffer.length));
  form.set('file', new Blob([chunkBuffer]), `part_${seq}`);
  const res = await fetch('https://open.feishu.cn/open-apis/drive/v1/files/upload_part', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
    body: form,
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`upload_part seq=${seq} 响应非 JSON：${text.slice(0, 300)}`);
  }
  if (!res.ok || parsed.code !== 0) {
    throw new Error(parsed.msg || `upload_part seq=${seq} 失败 HTTP ${res.status} code=${parsed.code}`);
  }
}

/**
 * @param {string} accessToken
 * @param {string} uploadId
 * @param {number} blockNum
 */
async function uploadFinish(accessToken, uploadId, blockNum) {
  const res = await fetch('https://open.feishu.cn/open-apis/drive/v1/files/upload_finish', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({ upload_id: uploadId, block_num: blockNum }),
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`upload_finish 响应非 JSON：${text.slice(0, 300)}`);
  }
  if (!res.ok || parsed.code !== 0) {
    throw new Error(parsed.msg || `upload_finish 失败 HTTP ${res.status} code=${parsed.code}`);
  }
  const fileToken = parsed.data?.file_token;
  if (typeof fileToken !== 'string' || !fileToken.trim()) {
    throw new Error('upload_finish 成功但未返回 file_token');
  }
  return { fileToken: fileToken.trim() };
}

/**
 * 分片上传（>20MB），支持断点续传：进度持久化到 bom_rows.status 的 feishu_mp_* 键。
 * 飞书 upload_id 有效期 24h，此处 23h 内视为可续传。
 * @param {object} p
 * @param {import('@supabase/supabase-js').SupabaseClient} p.supabase
 * @param {() => Promise<string>} p.getToken
 * @param {() => void} [p.invalidateToken] 分片重试前作废缓存 tenant token（飞书返回 invalid access token 时）
 * @param {string} p.parentFolderToken
 * @param {string} p.localAbsPath
 * @param {string} p.fileName
 * @param {number} p.fileSize
 * @param {string} p.rowId
 * @param {unknown} p.rowStatus
 * @param {AbortSignal} [p.signal]
 * @param {(info: { seq: number, blockNum: number, bytesUploaded: number }) => void} [p.onChunkDone]
 */
async function uploadFileMultipart(p) {
  const {
    supabase, getToken, invalidateToken, parentFolderToken, localAbsPath,
    fileName, fileSize, rowId, rowStatus, signal, onChunkDone,
  } = p;

  const existing = extractFeishuMultipartState(rowStatus);
  let uploadId, blockSize, blockNum, startedAt;
  /** @type {Set<number>} */
  let doneSeqs;

  if (
    existing &&
    existing.uploadId &&
    existing.parentToken === parentFolderToken &&
    existing.fileName === fileName &&
    existing.fileSize === fileSize &&
    existing.startedAt
  ) {
    const elapsed = Date.now() - new Date(existing.startedAt).getTime();
    if (elapsed < FEISHU_UPLOAD_ID_TTL_MS && existing.blockNum > 0) {
      uploadId = existing.uploadId;
      blockSize = existing.blockSize;
      blockNum = existing.blockNum;
      doneSeqs = new Set(existing.doneSeqs);
      startedAt = existing.startedAt;
      log('feishu-upload multipart resume', {
        rowId, uploadId: uploadId.slice(0, 16),
        done: doneSeqs.size, total: blockNum,
      });
    }
  }

  if (!uploadId) {
    if (existing) await clearBomRowFeishuMultipartState(supabase, rowId);
    const token = await getToken();
    const prep = await uploadPrepare(token, parentFolderToken, fileName, fileSize);
    uploadId = prep.uploadId;
    blockSize = prep.blockSize;
    blockNum = prep.blockNum;
    doneSeqs = new Set();
    startedAt = new Date().toISOString();
    await saveBomRowFeishuMultipartState(supabase, rowId, {
      uploadId, blockSize, blockNum,
      doneSeqs: [],
      parentToken: parentFolderToken,
      fileName, fileSize, startedAt,
    });
    log('feishu-upload multipart prepare', {
      rowId, uploadId: uploadId.slice(0, 16), blockSize, blockNum, fileSize,
    });
  }

  const fh = await fs.open(localAbsPath, 'r');
  try {
    for (let seq = 0; seq < blockNum; seq++) {
      if (signal?.aborted) throw new Error('用户取消');
      if (doneSeqs.has(seq)) continue;

      const offset = seq * blockSize;
      const chunkSize = Math.min(blockSize, fileSize - offset);
      const buf = Buffer.alloc(chunkSize);
      const { bytesRead } = await fh.read(buf, 0, chunkSize, offset);
      const chunk = bytesRead === chunkSize ? buf : buf.subarray(0, bytesRead);

      let lastErr = null;
      for (let attempt = 0; attempt <= FEISHU_PART_RETRY_MAX; attempt++) {
        try {
          const token = await getToken();
          await uploadPart(token, uploadId, seq, chunk);
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
          const em = e instanceof Error ? e.message : String(e);
          if (invalidateToken && isFeishuInvalidAccessTokenMessage(em)) {
            invalidateToken();
          }
          if (attempt < FEISHU_PART_RETRY_MAX) {
            const wait = FEISHU_PART_DELAY_MS * (attempt + 2);
            log('feishu-upload part retry', {
              rowId, seq, attempt: attempt + 1, wait,
              err: em,
            });
            await new Promise((r) => setTimeout(r, wait));
          }
        }
      }
      if (lastErr) throw lastErr;

      doneSeqs.add(seq);
      await saveBomRowFeishuMultipartState(supabase, rowId, {
        uploadId, blockSize, blockNum,
        doneSeqs: [...doneSeqs],
        parentToken: parentFolderToken,
        fileName, fileSize, startedAt,
      });

      if (onChunkDone) {
        const uploaded = Math.min((seq + 1) * blockSize, fileSize);
        onChunkDone({ seq, blockNum, bytesUploaded: uploaded });
      }

      if (seq < blockNum - 1) {
        await new Promise((r) => setTimeout(r, FEISHU_PART_DELAY_MS));
      }
    }
  } finally {
    await fh.close();
  }

  const token = await getToken();
  const { fileToken } = await uploadFinish(token, uploadId, blockNum);
  await clearBomRowFeishuMultipartState(supabase, rowId);

  return { fileToken, sizeBytes: fileSize };
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} rootAbs
 * @param {{ id: string, batch_id: string, row_ids: string[], progress_total: number }} job
 * @param {import('./workerTuning.mjs').WorkerTuning} tuning
 */
export async function executeFeishuUploadJob(supabase, rootAbs, job, tuning) {
  const jobId = job.id;
  const rowIds = Array.isArray(job.row_ids) ? job.row_ids : [];
  const total = rowIds.length;

  if (!total) {
    await patchFeishuUploadJob(supabase, jobId, {
      status: 'failed',
      finished_at: new Date().toISOString(),
      last_message: '任务无行',
      cancel_requested: false,
    });
    return;
  }

  const { appId, appSecret } = await loadFeishuAppCreds(supabase);
  if (!appId || !appSecret) {
    await patchFeishuUploadJob(supabase, jobId, {
      status: 'failed',
      finished_at: new Date().toISOString(),
      last_message: '未配置飞书应用：环境变量 FEISHU_APP_ID/FEISHU_APP_SECRET 或 system_settings.feishu_config',
      cancel_requested: false,
    });
    return;
  }

  const scannerVal = await fetchBomScannerValue(supabase);
  const keyMap = mergeKeyMap(scannerVal);
  const batchProdCfg = await fetchBatchProductDistributionSettings(supabase, job.batch_id);
  const rootFolder = safeTrim(batchProdCfg.feishuDriveRootFolderToken);
  if (!rootFolder) {
    await patchFeishuUploadJob(supabase, jobId, {
      status: 'failed',
      finished_at: new Date().toISOString(),
      last_message: '未配置飞书云盘根目录 folder_token（请在产品分发配置中设置）',
      cancel_requested: false,
    });
    return;
  }

  const batchNameRaw = batchProdCfg.batchName;
  const batchNameFallback = `batch-${String(job.batch_id).replace(/-/g, '').slice(0, 8)}`;
  const batchDir = safePathSegment(batchNameRaw || batchNameFallback);

  const hbMs = tuning.heartbeatMs;
  let globalHbTimer = null;
  /** @type {AbortController | null} */
  let currentRowAbort = null;
  let lastJobMessage = '';
  const jobStartMs = Date.now();
  let hbLogCounter = 0;

  try {
    await reportBomLocalRootRuntime(supabase, rootAbs, { phase: 'busy', busyHint: 'feishu-upload' });
    globalHbTimer = setInterval(() => {
      void reportBomLocalRootRuntime(supabase, rootAbs, { phase: 'busy', busyHint: 'feishu-upload' });
      void patchFeishuUploadJob(supabase, jobId, {
        heartbeat_at: new Date().toISOString(),
        last_message: lastJobMessage ? String(lastJobMessage).slice(0, 2000) : '上传中…',
      });
      const elapsed = Math.round((Date.now() - jobStartMs) / 1000);
      hbLogCounter += 1;
      if (hbLogCounter % 2 === 0) {
        log('feishu-upload heartbeat', {
          jobId,
          message: (lastJobMessage || '上传中…').slice(0, 180),
          elapsedSec: elapsed,
        });
      }
      void (async () => {
        if (await isFeishuUploadJobCancelRequested(supabase, jobId)) {
          if (currentRowAbort) currentRowAbort.abort();
        }
      })();
    }, hbMs);

    const feishuToken = createFeishuTokenManager(appId, appSecret);
    const getToken = () => feishuToken.getAccessToken();

    let completed = 0;
    let nOk = 0;
    let nFail = 0;
    let nSkip = 0;
    /** @type {string[]} */
    const failSamples = [];
    const rememberFailSample = (msg) => {
      const m = String(msg ?? '').trim();
      if (!m) return;
      if (failSamples.length < 3) failSamples.push(m.slice(0, 160));
    };
    let userCancelled = false;

    for (const rowId of rowIds) {
      if (await isFeishuUploadJobCancelRequested(supabase, jobId)) {
        userCancelled = true;
        break;
      }

      const { data: still, error: e1 } = await supabase.rpc('bom_row_still_eligible_for_feishu_upload', {
        p_row_id: rowId,
      });
      if (e1) log('WARN bom_row_still_eligible_for_feishu_upload', e1.message);

      if (!still) {
        nSkip += 1;
        completed += 1;
        lastJobMessage = `${completed}/${total} 跳过（状态已变或非上传目标）`;
        await patchFeishuUploadJob(supabase, jobId, {
          progress_current: completed,
          running_row_id: null,
          heartbeat_at: new Date().toISOString(),
          last_message: lastJobMessage,
        });
        continue;
      }

      const { data: rowRec, error: rowErr } = await supabase
        .from('bom_rows')
        .select('id,bom_row,status')
        .eq('id', rowId)
        .maybeSingle();
      if (rowErr || !rowRec) {
        nFail += 1;
        completed += 1;
        const reason = rowErr?.message ? `读取行失败：${rowErr.message}` : '行不存在';
        rememberFailSample(reason);
        lastJobMessage = `${completed}/${total} ${reason}`;
        await patchFeishuUploadJob(supabase, jobId, {
          progress_current: completed,
          running_row_id: null,
          heartbeat_at: new Date().toISOString(),
          last_message: lastJobMessage,
        });
        continue;
      }

      const bomRow =
        rowRec.bom_row && typeof rowRec.bom_row === 'object' ? /** @type {Record<string, unknown>} */ (rowRec.bom_row) : {};
      const md5Lower = extractExpectedMd5Lower(bomRow, keyMap);
      if (!md5Lower) {
        nFail += 1;
        completed += 1;
        const reason = '飞书上传：缺少合法期望 MD5';
        rememberFailSample(reason);
        await patchBomRowFeishuUploadError(supabase, rowId, reason);
        lastJobMessage = `${completed}/${total} 缺少 MD5`;
        await patchFeishuUploadJob(supabase, jobId, {
          progress_current: completed,
          running_row_id: null,
          heartbeat_at: new Date().toISOString(),
          last_message: lastJobMessage,
        });
        continue;
      }

      const relPathDisk = await findLocalPathForMd5(supabase, md5Lower);
      if (!relPathDisk) {
        nFail += 1;
        completed += 1;
        const reason = '飞书上传：本地索引中无该 MD5，请先完成本地扫描';
        rememberFailSample(reason);
        await patchBomRowFeishuUploadError(supabase, rowId, reason);
        lastJobMessage = `${completed}/${total} 本地无文件`;
        await patchFeishuUploadJob(supabase, jobId, {
          progress_current: completed,
          running_row_id: null,
          heartbeat_at: new Date().toISOString(),
          last_message: lastJobMessage,
        });
        continue;
      }

      const diskAbs = path.join(rootAbs, relPathDisk.split('/').join(path.sep));
      const fileName = safeFlatFilename(path.basename(diskAbs));
      const middleDir = resolveMiddleDirFromRow(bomRow, keyMap);
      const pathSegments = middleDir ? [batchDir, middleDir] : [batchDir];

      log('feishu-upload row start', {
        jobId,
        rowId,
        md5: md5Lower,
        fileName,
        pathSegments,
        tokenStats: feishuToken.stats(),
      });

      lastJobMessage = `${completed + 1}/${total} 上传中…（分片 1/1） 文件：${fileName}`;
      await patchFeishuUploadJob(supabase, jobId, {
        running_row_id: rowId,
        heartbeat_at: new Date().toISOString(),
        last_message: lastJobMessage,
      });

      rowFeishuTry: for (let feishuTokenAttempt = 0; feishuTokenAttempt < 2; feishuTokenAttempt += 1) {
        currentRowAbort = new AbortController();
        try {
          let fileStat;
          try {
            fileStat = await fs.stat(diskAbs);
          } catch {
            throw new Error(`本地文件不存在：${diskAbs}`);
          }
          if (!fileStat.isFile()) throw new Error('本地路径不是文件');
          const rowUploadStartedAt = Date.now();

          const token = await getToken();
          const parentToken = await ensureFolderPath(token, rootFolder, pathSegments);
          await removeSameNameFileIfAny(token, parentToken, fileName);

          let fileToken, sizeBytes;
          if (fileStat.size <= FEISHU_UPLOAD_ALL_MAX_BYTES) {
            const r = await uploadAllUnderFolder(token, parentToken, diskAbs, fileName);
            fileToken = r.fileToken;
            sizeBytes = r.sizeBytes;
          } else {
            log('feishu-upload multipart needed', {
              rowId, fileName,
              size: formatBytes(fileStat.size),
              sizeRaw: fileStat.size,
            });
            const r = await uploadFileMultipart({
              supabase,
              getToken,
              invalidateToken: () => feishuToken.invalidate('upload_part invalid-access-token'),
              parentFolderToken: parentToken,
              localAbsPath: diskAbs,
              fileName,
              fileSize: fileStat.size,
              rowId,
              rowStatus: rowRec.status,
              signal: currentRowAbort.signal,
              onChunkDone: ({ seq, blockNum, bytesUploaded }) => {
                const elapsedMs = Date.now() - rowUploadStartedAt;
                let etaText = '预计剩余 --';
                if (bytesUploaded >= fileStat.size) {
                  etaText = '预计剩余 0秒';
                } else if (bytesUploaded > 0 && elapsedMs >= 1500) {
                  const speedBytesPerSec = bytesUploaded / (elapsedMs / 1000);
                  if (speedBytesPerSec > 0) {
                    const etaSeconds = (fileStat.size - bytesUploaded) / speedBytesPerSec;
                    etaText = `预计剩余 ${formatEtaSeconds(etaSeconds)}`;
                  }
                }
                lastJobMessage = `${completed + 1}/${total} 上传中…（分片 ${seq + 1}/${blockNum}，${formatBytes(bytesUploaded)}/${formatBytes(fileStat.size)}，${etaText}） 文件：${fileName}`;
                void patchFeishuUploadJob(supabase, jobId, {
                  heartbeat_at: new Date().toISOString(),
                  last_message: lastJobMessage,
                });
              },
            });
            fileToken = r.fileToken;
            sizeBytes = r.sizeBytes;
          }

          await patchBomRowFeishuAfterUpload(supabase, rowId, {
            fileToken,
            fileName,
            sizeBytes,
          });

          nOk += 1;
          completed += 1;
          lastJobMessage = `${completed}/${total} OK（${formatBytes(sizeBytes)}） 文件：${fileName}`;
          await patchFeishuUploadJob(supabase, jobId, {
            progress_current: completed,
            running_row_id: null,
            heartbeat_at: new Date().toISOString(),
            last_message: lastJobMessage,
          });
          break rowFeishuTry;
        } catch (e) {
          const aborted =
            currentRowAbort.signal.aborted ||
            (e instanceof Error && (e.name === 'AbortError' || e.message === '用户取消'));
          if (aborted) {
            userCancelled = true;
            log('feishu-upload row aborted', { jobId, rowId });
            break rowFeishuTry;
          }
          const msg = (e instanceof Error ? e.message : String(e)).slice(0, 1000);
          if (feishuTokenAttempt === 0 && isFeishuInvalidAccessTokenMessage(msg)) {
            feishuToken.invalidate('row-level invalid-access-token');
            log('feishu-upload row retry after invalid access token', {
              jobId,
              rowId,
              tokenStats: feishuToken.stats(),
            });
            continue rowFeishuTry;
          }
          nFail += 1;
          completed += 1;
          rememberFailSample(msg);
          log('feishu-upload row failed', {
            jobId,
            rowId,
            error: msg,
            detail: extractErrorDetail(e),
          });
          await patchBomRowFeishuUploadError(supabase, rowId, `飞书上传失败：${msg}`);
          lastJobMessage = `${completed}/${total} 失败（${msg}） 文件：${fileName}`.slice(0, 2000);
          await patchFeishuUploadJob(supabase, jobId, {
            progress_current: completed,
            running_row_id: null,
            heartbeat_at: new Date().toISOString(),
            last_message: lastJobMessage,
          });
          break rowFeishuTry;
        } finally {
          currentRowAbort = null;
        }
      }

      if (userCancelled) break;
    }

    if (userCancelled) {
      await patchFeishuUploadJob(supabase, jobId, {
        status: 'cancelled',
        finished_at: new Date().toISOString(),
        last_message: `用户取消（已完成 ${completed}/${total}）`.slice(0, 2000),
        cancel_requested: false,
        running_row_id: null,
      });
      log('feishu-upload-job cancelled', jobId);
      return;
    }

    let finalStatus = 'succeeded';
    let summary = `完成：成功 ${nOk}，失败 ${nFail}，跳过 ${nSkip}`;
    if (nOk === 0 && nFail > 0) {
      finalStatus = 'failed';
      summary = `失败：成功 ${nOk}，失败 ${nFail}，跳过 ${nSkip}`;
    } else if (nOk > 0 && nFail > 0) {
      summary = `部分失败：成功 ${nOk}，失败 ${nFail}，跳过 ${nSkip}`;
    }
    if (nFail > 0 && failSamples.length > 0) {
      summary = `${summary}；原因示例：${failSamples.join(' | ')}`.slice(0, 2000);
    }

    await patchFeishuUploadJob(supabase, jobId, {
      status: finalStatus,
      finished_at: new Date().toISOString(),
      last_message: summary.slice(0, 2000),
      running_row_id: null,
      cancel_requested: false,
    });
    log('feishu-upload-job done', jobId, { status: finalStatus, summary });
  } finally {
    if (globalHbTimer) clearInterval(globalHbTimer);
    currentRowAbort = null;
    await reportBomLocalRootRuntime(supabase, rootAbs, { phase: 'idle' });
  }
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} rootAbs
 * @param {import('./workerTuning.mjs').WorkerTuning} tuning
 */
export async function drainFeishuUploadJobs(supabase, rootAbs, tuning) {
  for (;;) {
    const { data, error } = await supabase.rpc('bom_claim_feishu_upload_job');
    if (error) {
      log('WARN bom_claim_feishu_upload_job', error.message);
      break;
    }
    const rows = Array.isArray(data) ? data : data ? [data] : [];
    const first = rows[0];
    if (!first?.id) break;
    try {
      await executeFeishuUploadJob(
        supabase,
        rootAbs,
        {
          id: first.id,
          batch_id: first.batch_id,
          row_ids: first.row_ids ?? [],
          progress_total: first.progress_total ?? 0,
        },
        tuning,
      );
    } catch (e) {
      const msg = (e instanceof Error ? e.message : String(e)).slice(0, 2000);
      log('ERROR executeFeishuUploadJob', first.id, {
        error: msg,
        detail: extractErrorDetail(e),
      });
      await patchFeishuUploadJob(supabase, first.id, {
        status: 'failed',
        finished_at: new Date().toISOString(),
        last_message: msg,
        running_row_id: null,
        cancel_requested: false,
      });
    }
  }
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {number} staleSec
 */
export async function failStaleFeishuUploadJobs(supabase, staleSec) {
  const sec = Number.isFinite(staleSec) && staleSec >= 60 ? Math.floor(staleSec) : 900;
  const { data, error } = await supabase.rpc('bom_fail_stale_feishu_upload_jobs', { p_stale_seconds: sec });
  if (error) {
    log('WARN bom_fail_stale_feishu_upload_jobs', error.message);
    return;
  }
  const n = typeof data === 'number' ? data : Number(data);
  if (n > 0) log('bom_fail_stale_feishu_upload_jobs', n);
}
