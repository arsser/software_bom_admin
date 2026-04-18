import { createReadStream } from 'node:fs';
import path from 'node:path';
import { patchBomRowExtStatus, withExt } from './bomRowStatusJson.mjs';
import { reportBomLocalRootRuntime } from './workerRuntimeReport.mjs';

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const MAX_HTTP_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 3000;

function isRetriableHttpError(e) {
  if (!e || typeof e !== 'object') return false;
  const msg = String(e.message || '').toLowerCase();
  if (e.name === 'AbortError' || msg === 'aborted') return false;
  if (msg.includes('timeout')) return false;
  if (msg.includes('fetch failed') || msg.includes('econnreset') || msg.includes('econnrefused') ||
      msg.includes('epipe') || msg.includes('socket hang up') || msg.includes('network')) return true;
  const httpMatch = msg.match(/^(?:checksum search |copy |deploy )?http (\d+)/i);
  if (httpMatch) {
    const code = Number(httpMatch[1]);
    return code >= 500 || code === 408 || code === 429;
  }
  return false;
}

/**
 * @template T
 * @param {() => Promise<T>} fn
 * @param {{ signal?: AbortSignal; label?: string; maxRetries?: number }} [opts]
 * @returns {Promise<{ result: T; retries: number }>}
 */
async function withRetry(fn, opts = {}) {
  const cap = typeof opts.maxRetries === 'number' && opts.maxRetries >= 0 ? opts.maxRetries : MAX_HTTP_RETRIES;
  let retries = 0;
  for (let attempt = 0; ; attempt++) {
    try {
      const result = await fn();
      return { result, retries };
    } catch (e) {
      if (opts.signal?.aborted) throw e;
      if (attempt >= cap || !isRetriableHttpError(e)) throw e;
      retries += 1;
      const delay = RETRY_BASE_DELAY_MS * (attempt + 1);
      log('ext-sync retry', opts.label || '', `attempt ${attempt + 1}/${cap}`, e.message, `wait ${delay}ms`);
      await sleep(delay);
    }
  }
}

/** @param {string} apiKey */
function artifactoryHeaders(apiKey) {
  const k = String(apiKey || '').trim();
  return {
    Authorization: `Bearer ${k}`,
    'X-JFrog-Art-Api': k,
    'X-Api-Key': k,
  };
}

/** @param {string} baseUrl */
export function normalizeArtifactoryRootUrl(baseUrl) {
  let u = String(baseUrl || '').trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  u = u.replace(/\/+$/, '');
  if (!/\/artifactory$/i.test(u)) {
    u = `${u}/artifactory`;
  }
  return u;
}

/** @param {Record<string, unknown>} row @param {string[]} keys */
function firstNonEmptyByKeys(row, keys) {
  if (!row || typeof row !== 'object') return null;
  for (const key of keys) {
    if (!key || !Object.prototype.hasOwnProperty.call(row, key)) continue;
    const v = String(row[key] ?? '').trim();
    if (v) return v;
  }
  return null;
}

/** @param {string} s */
function normalizeBomKeyForMatch(s) {
  return String(s)
    .normalize('NFKC')
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .trim()
    .toLowerCase();
}

/** @param {Record<string, unknown>} row @param {string[]} keys */
export function firstNonEmptyByKeysRelaxed(row, keys) {
  const exact = firstNonEmptyByKeys(row, keys);
  if (exact) return exact;
  if (!row || typeof row !== 'object') return null;
  const want = new Set(keys.map((k) => normalizeBomKeyForMatch(k)).filter(Boolean));
  for (const [k, val] of Object.entries(row)) {
    if (want.has(normalizeBomKeyForMatch(k))) {
      const v = String(val ?? '').trim();
      if (v) return v;
    }
  }
  for (const [k, val] of Object.entries(row)) {
    if (/分组/.test(String(k))) {
      const v = String(val ?? '').trim();
      if (v) return v;
    }
  }
  return null;
}

/** @param {unknown} v */
function isValidMd5Hex(v) {
  return typeof v === 'string' && /^[a-f0-9]{32}$/i.test(v.trim());
}

const DEFAULT_KEY_MAP = {
  downloadUrl: ['下载路径', 'url', 'download_url', '下载地址'],
  expectedMd5: ['MD5', 'md5', 'checksum'],
  arch: ['硬件平台', 'arch', 'platform', '架构'],
  extUrl: ['ext_url', 'extUrl', '转存地址'],
  releaseVersion: ['版本', 'version', 'releaseVersion', '产品版本'],
  releaseBatch: ['批次', 'batch', 'releaseBatch', '发布批次'],
  moduleName: ['模块', 'module', '组件', 'moduleName'],
  groupSegment: ['分组', 'group', 'groupName', '组别'],
};

/**
 * @param {Record<string, unknown>} scannerValue
 * @returns {typeof DEFAULT_KEY_MAP}
 */
export function mergeKeyMap(scannerValue) {
  const jm = scannerValue?.jsonKeyMap && typeof scannerValue.jsonKeyMap === 'object' ? scannerValue.jsonKeyMap : {};
  /** @param {string} k @param {string[]} def */
  const arr = (k, def) => {
    const v = jm[k];
    return Array.isArray(v) && v.length && v.every((x) => typeof x === 'string') ? /** @type {string[]} */ (v) : def;
  };
  return {
    downloadUrl: arr('downloadUrl', DEFAULT_KEY_MAP.downloadUrl),
    expectedMd5: arr('expectedMd5', DEFAULT_KEY_MAP.expectedMd5),
    arch: arr('arch', DEFAULT_KEY_MAP.arch),
    extUrl: arr('extUrl', DEFAULT_KEY_MAP.extUrl),
    releaseVersion: arr('releaseVersion', DEFAULT_KEY_MAP.releaseVersion),
    releaseBatch: arr('releaseBatch', DEFAULT_KEY_MAP.releaseBatch),
    moduleName: arr('moduleName', DEFAULT_KEY_MAP.moduleName),
    groupSegment: arr('groupSegment', DEFAULT_KEY_MAP.groupSegment),
  };
}

/** @param {unknown} seg */
function normalizePathSegmentValue(seg) {
  return String(seg ?? '')
    .normalize('NFKC')
    .replace(/[\u200b-\u200d\ufeff\u3000]/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** @param {string} seg */
export function safePathSegment(seg) {
  const t = normalizePathSegmentValue(seg)
    .replace(/[/\\?*:|"<>]/g, '_')
    .replace(/\s+/g, ' ')
    .slice(0, 160);
  return t || 'unknown';
}

/** @param {string} name */
export function safeFlatFilename(name) {
  const base = name && String(name).trim() ? String(name).trim() : 'artifact.bin';
  const cleaned = base.replace(/[/\\?*:|"<>]/g, '_').replace(/\s+/g, ' ');
  return cleaned.slice(0, 220) || 'artifact.bin';
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 */
export async function fetchBomScannerValue(supabase) {
  const { data, error } = await supabase.from('system_settings').select('value').eq('key', 'bom_scanner').maybeSingle();
  if (error) throw error;
  const v = data?.value;
  return v && typeof v === 'object' ? /** @type {Record<string, unknown>} */ (v) : {};
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} batchId
 */
export async function fetchBatchProductDistributionSettings(supabase, batchId) {
  const { data, error } = await supabase
    .from('bom_batches')
    .select('name,product_id,products(name,ext_artifactory_repo,feishu_drive_root_folder_token)')
    .eq('id', batchId)
    .maybeSingle();
  if (error) throw error;
  const batchName = data?.name && String(data.name).trim() ? String(data.name).trim() : '';
  const product = data?.products ?? {};
  return {
    batchName,
    productName: product?.name && String(product.name).trim() ? String(product.name).trim() : '',
    extArtifactoryRepo:
      product?.ext_artifactory_repo && String(product.ext_artifactory_repo).trim()
        ? String(product.ext_artifactory_repo).trim()
        : '',
    feishuDriveRootFolderToken:
      product?.feishu_drive_root_folder_token && String(product.feishu_drive_root_folder_token).trim()
        ? String(product.feishu_drive_root_folder_token).trim()
        : '',
  };
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 */
async function loadExtCredsFromDb(supabase) {
  const { data, error } = await supabase.from('system_settings').select('value').eq('key', 'artifactory_config').maybeSingle();
  if (error) {
    log('WARN load artifactory_config for ext', error.message);
    return { apiKey: '', baseUrl: '' };
  }
  const v = data?.value ?? {};
  return {
    apiKey: typeof v.artifactoryExtApiKey === 'string' ? v.artifactoryExtApiKey.trim() : '',
    baseUrl: typeof v.artifactoryExtBaseUrl === 'string' ? v.artifactoryExtBaseUrl.trim() : '',
  };
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 */
export async function resolveExtArtifactoryCreds(supabase) {
  const db = await loadExtCredsFromDb(supabase);
  const envKey = String(process.env.IT_ARTIFACTORY_EXT_API_KEY ?? '').trim();
  const envBase = String(process.env.IT_ARTIFACTORY_EXT_BASE_URL ?? '').trim();
  return {
    apiKey: envKey || db.apiKey,
    baseUrl: envBase || db.baseUrl,
  };
}

/** @param {string} storageUri */
export function parseArtifactoryStorageUri(storageUri) {
  const s = String(storageUri || '').trim();
  const marker = '/artifactory/api/storage/';
  const i = s.indexOf(marker);
  if (i < 0) return null;
  const rest = s.slice(i + marker.length).split('?')[0];
  const parts = rest.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const repo = parts[0];
  const relPath = parts.slice(1).join('/');
  return { repo, path: relPath };
}

/**
 * @param {string} rootUrl normalized .../artifactory
 * @param {string} md5Lower
 * @param {string} apiKey
 */
/**
 * @param {string} rootUrl
 * @param {string} md5Lower
 * @param {string} apiKey
 * @param {AbortSignal} [signal]
 */
async function checksumSearch(rootUrl, md5Lower, apiKey, signal) {
  const base = rootUrl.endsWith('/') ? rootUrl : `${rootUrl}/`;
  const u = new URL('api/search/checksum', base);
  u.searchParams.set('md5', md5Lower);
  const res = await fetch(u, {
    signal,
    headers: { ...artifactoryHeaders(apiKey), Accept: 'application/json' },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`checksum search HTTP ${res.status}: ${text.slice(0, 400)}`);
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error('checksum search: invalid JSON');
  }
  const results = Array.isArray(body.results) ? body.results : [];
  return results
    .map((r) => ({
      uri: typeof r.uri === 'string' ? r.uri : '',
      downloadUri: typeof r.downloadUri === 'string' ? r.downloadUri : '',
    }))
    .filter((r) => r.uri);
}

/**
 * @param {string} rootUrl
 * @param {string} srcRepo
 * @param {string} srcPath
 * @param {string} dstRepo
 * @param {string} dstPath
 * @param {string} apiKey
 * @param {AbortSignal} [signal]
 */
async function copyArtifact(rootUrl, srcRepo, srcPath, dstRepo, dstPath, apiKey, signal) {
  const base = rootUrl.endsWith('/') ? rootUrl : `${rootUrl}/`;
  const relFrom = `api/copy/${srcRepo}/${srcPath}`.replace(/\/+/g, '/').replace(/^\/+/, '');
  const u = new URL(relFrom, base);
  u.searchParams.set('to', `${dstRepo}/${dstPath}`);
  const res = await fetch(u, {
    signal,
    method: 'POST',
    headers: { ...artifactoryHeaders(apiKey), Accept: 'application/json' },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`copy HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
  return text;
}

/**
 * @param {AbortSignal} [signal]
 */
async function deployFileFixed(rootUrl, repo, relPath, fileAbs, apiKey, signal) {
  const base = rootUrl.replace(/\/+$/, '');
  const putUrl = `${base}/${repo}/${relPath.replace(/^\/+/, '')}`;
  const st = artifactoryHeaders(apiKey);
  const body = createReadStream(fileAbs);
  if (signal) {
    signal.addEventListener(
      'abort',
      () => {
        try {
          body.destroy();
        } catch {
          /* ignore */
        }
      },
      { once: true },
    );
  }
  const res = await fetch(putUrl, {
    signal,
    method: 'PUT',
    headers: { ...st, 'Content-Type': 'application/octet-stream' },
    duplex: 'half',
    body,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`deploy HTTP ${res.status}: ${t.slice(0, 500)}`);
  }
}

/** @param {string} rootUrl @param {string} repo @param {string} relPath */
export function buildArtifactoryDownloadUrl(rootUrl, repo, relPath) {
  const base = rootUrl.replace(/\/+$/, '');
  return `${base}/${repo}/${relPath.replace(/^\/+/, '')}`;
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} jobId
 * @param {Record<string, unknown>} patch
 */
async function patchExtSyncJob(supabase, jobId, patch) {
  const { error } = await supabase.from('bom_ext_sync_jobs').update(patch).eq('id', jobId);
  if (error) log('WARN patchExtSyncJob', jobId, error.message);
}

/** @param {import('@supabase/supabase-js').SupabaseClient} supabase @param {string} jobId */
async function isExtSyncJobCancelRequested(supabase, jobId) {
  const { data, error } = await supabase
    .from('bom_ext_sync_jobs')
    .select('cancel_requested')
    .eq('id', jobId)
    .maybeSingle();
  if (error) {
    log('WARN ext cancel_requested read', error.message);
    return false;
  }
  return Boolean(data?.cancel_requested);
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} md5Lower
 */
export async function findLocalPathForMd5(supabase, md5Lower) {
  const { data, error } = await supabase.from('local_file').select('path').eq('md5', md5Lower).limit(1).maybeSingle();
  if (error) throw error;
  if (data?.path) return data.path;
  const { data: data2, error: e2 } = await supabase.from('local_file').select('path').eq('md5', md5Lower.toUpperCase()).limit(1).maybeSingle();
  if (e2) throw e2;
  return data2?.path ?? null;
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} rootAbs
 * @param {{ id: string, batch_id: string, row_ids: string[], progress_total: number }} job
 * @param {import('./workerTuning.mjs').WorkerTuning} tuning
 */
export async function executeExtSyncJob(supabase, rootAbs, job, tuning) {
  const jobId = job.id;
  const rowIds = Array.isArray(job.row_ids) ? job.row_ids : [];
  const total = rowIds.length;

  if (!total) {
    await patchExtSyncJob(supabase, jobId, {
      status: 'failed',
      finished_at: new Date().toISOString(),
      last_message: '任务无行',
      cancel_requested: false,
    });
    return;
  }

  const creds = await resolveExtArtifactoryCreds(supabase);
  if (!creds.apiKey || !creds.baseUrl) {
    await patchExtSyncJob(supabase, jobId, {
      status: 'failed',
      finished_at: new Date().toISOString(),
      last_message: '未配置外部 Artifactory（IT_ARTIFACTORY_EXT_* 环境变量或 artifactory_config 外部实例）',
      cancel_requested: false,
    });
    return;
  }

  const scannerVal = await fetchBomScannerValue(supabase);
  const keyMap = mergeKeyMap(scannerVal);
  const batchProdCfg = await fetchBatchProductDistributionSettings(supabase, job.batch_id);
  const extRepo = batchProdCfg.extArtifactoryRepo;
  if (!extRepo) {
    await patchExtSyncJob(supabase, jobId, {
      status: 'failed',
      finished_at: new Date().toISOString(),
      last_message: '未配置 ext 目标仓库：请在产品分发配置中填写外部 Artifactory 仓库 key',
      cancel_requested: false,
    });
    return;
  }

  const rootUrl = normalizeArtifactoryRootUrl(creds.baseUrl);

  // 目标路径：一级目录用 bom_batches.name；二级目录用 bom_row["分组"]
  const batchNameRaw = batchProdCfg.batchName;
  const batchNameFallback = `batch-${String(job.batch_id).replace(/-/g, '').slice(0, 8)}`;
  const batchName = batchNameRaw || batchNameFallback;

  const hbMs = tuning.heartbeatMs;
  let globalHbTimer = null;
  /** @type {AbortController | null} */
  let currentRowAbort = null;
  try {
    await reportBomLocalRootRuntime(supabase, rootAbs, { phase: 'busy', busyHint: 'ext-sync' });
    globalHbTimer = setInterval(() => {
      void reportBomLocalRootRuntime(supabase, rootAbs, { phase: 'busy', busyHint: 'ext-sync' });
      void (async () => {
        if (await isExtSyncJobCancelRequested(supabase, jobId)) {
          if (currentRowAbort) currentRowAbort.abort();
        }
      })();
    }, hbMs);

  let completed = 0;
  let nOk = 0;
  let nFail = 0;
  let nSkip = 0;
  let nRetries = 0;
  let userCancelled = false;

  for (const rowId of rowIds) {
    if (await isExtSyncJobCancelRequested(supabase, jobId)) {
      userCancelled = true;
      break;
    }
    const { data: still, error: e1 } = await supabase.rpc('bom_row_still_eligible_for_ext_sync', { p_row_id: rowId });
    if (e1) log('WARN bom_row_still_eligible_for_ext_sync', e1.message);

    if (!still) {
      nSkip += 1;
      completed += 1;
      await patchExtSyncJob(supabase, jobId, {
        progress_current: completed,
        running_row_id: null,
        heartbeat_at: new Date().toISOString(),
        last_message: `${completed}/${total} 跳过（已非校验通过或已有 ext_url）`,
      });
      continue;
    }

    const { data: rowRec, error: rowErr } = await supabase.from('bom_rows').select('id,bom_row').eq('id', rowId).maybeSingle();
    if (rowErr || !rowRec) {
      nFail += 1;
      completed += 1;
      await patchExtSyncJob(supabase, jobId, {
        progress_current: completed,
        running_row_id: null,
        heartbeat_at: new Date().toISOString(),
        last_message: `${completed}/${total} 行不存在`,
      });
      continue;
    }

    const bomRow = rowRec.bom_row && typeof rowRec.bom_row === 'object' ? /** @type {Record<string, unknown>} */ (rowRec.bom_row) : {};
    const md5Raw = firstNonEmptyByKeys(bomRow, keyMap.expectedMd5);
    const md5Lower = md5Raw && isValidMd5Hex(md5Raw) ? md5Raw.trim().toLowerCase() : null;
    if (!md5Lower) {
      nFail += 1;
      completed += 1;
      await patchBomRowExtStatus(supabase, rowId, 'error', 'ext 同步：缺少合法期望 MD5');
      await patchExtSyncJob(supabase, jobId, {
        progress_current: completed,
        running_row_id: null,
        heartbeat_at: new Date().toISOString(),
        last_message: `${completed}/${total} 缺少 MD5`,
      });
      continue;
    }

    log('ext-sync row start', {
      jobId,
      rowId,
      md5: md5Lower,
      extRepo,
    });

    await patchExtSyncJob(supabase, jobId, {
      running_row_id: rowId,
      heartbeat_at: new Date().toISOString(),
      last_message: `${completed + 1}/${total} 同步中…`,
    });

    currentRowAbort = new AbortController();
    const rowSignal = AbortSignal.any([currentRowAbort.signal, AbortSignal.timeout(tuning.httpTimeoutMs)]);
    try {
      const relPathDisk = await findLocalPathForMd5(supabase, md5Lower);
      if (!relPathDisk) {
        throw new Error('本地索引中无该 MD5 对应文件（请先扫描暂存目录）');
      }
      const diskAbs = path.join(rootAbs, relPathDisk.split('/').join(path.sep));
      const fileName = safeFlatFilename(path.basename(diskAbs));

      const modRaw = firstNonEmptyByKeysRelaxed(bomRow, keyMap.moduleName);
      const groupRaw = firstNonEmptyByKeysRelaxed(bomRow, keyMap.groupSegment);
      const midDir = modRaw ? safePathSegment(modRaw) : groupRaw ? safePathSegment(groupRaw) : null;
      const batchDir = safePathSegment(batchName);
      // 与飞书对账一致：{repo}/{batchName}/{组件或分组?}/{fileName}
      const targetRel = midDir ? [batchDir, midDir, fileName].join('/') : [batchDir, fileName].join('/');

      const targetDl = buildArtifactoryDownloadUrl(rootUrl, extRepo, targetRel);
      log('ext-sync row target', {
        jobId,
        rowId,
        md5: md5Lower,
        targetRel,
        targetDl,
        localRelPath: relPathDisk,
        localFile: diskAbs,
      });

      let syncKind = 'uploaded';
      let rowRetries = 0;
      log('ext-sync checksum search', { jobId, rowId, md5: md5Lower, repos: extRepo });
      const { result: hits, retries: r1 } = await withRetry(
        () => checksumSearch(rootUrl, md5Lower, creds.apiKey, rowSignal),
        { signal: rowSignal, label: `checksum ${rowId}`, maxRetries: tuning.httpRetries },
      );
      rowRetries += r1;
      nRetries += r1;
      hits.sort((a, b) => a.uri.localeCompare(b.uri));
      const first = hits[0];
      log('ext-sync checksum hits', {
        jobId,
        rowId,
        md5: md5Lower,
        hitCount: hits.length,
        pickedUri: first?.uri ?? null,
      });

      if (first) {
        const parsed = parseArtifactoryStorageUri(first.uri);
        if (!parsed) {
          throw new Error('无法解析 checksum 结果的 storage URI');
        }
        const samePath =
          parsed.repo === extRepo && parsed.path.replace(/\/+$/, '') === targetRel.replace(/\/+$/, '');
        if (samePath) {
          syncKind = 'copied';
          log('ext-sync copy skipped (samePath)', { jobId, rowId, fromRepo: parsed.repo, toRel: targetRel });
        } else {
          log('ext-sync copy', {
            jobId,
            rowId,
            fromRepo: parsed.repo,
            fromPath: parsed.path,
            toRepo: extRepo,
            toRel: targetRel,
          });
          const { retries: r2 } = await withRetry(
            () => copyArtifact(rootUrl, parsed.repo, parsed.path, extRepo, targetRel, creds.apiKey, rowSignal),
            { signal: rowSignal, label: `copy ${rowId}`, maxRetries: tuning.httpRetries },
          );
          rowRetries += r2;
          nRetries += r2;
          syncKind = 'copied';
        }
      } else {
        log('ext-sync put upload', {
          jobId,
          rowId,
          repo: extRepo,
          toRel: targetRel,
          localAbs: diskAbs,
        });
        const { retries: r3 } = await withRetry(
          () => deployFileFixed(rootUrl, extRepo, targetRel, diskAbs, creds.apiKey, rowSignal),
          { signal: rowSignal, label: `deploy ${rowId}`, maxRetries: tuning.httpRetries },
        );
        rowRetries += r3;
        nRetries += r3;
        syncKind = 'uploaded';
      }

      const extAliases = keyMap.extUrl.length ? keyMap.extUrl : ['ext_url'];
      const nextBom = { ...bomRow, ext_sync_kind: syncKind };
      for (const k of extAliases) {
        if (k) nextBom[k] = targetDl;
      }

      const { data: stRow, error: stErr } = await supabase.from('bom_rows').select('status').eq('id', rowId).maybeSingle();
      if (stErr) throw stErr;
      const stOk = { ...withExt(stRow?.status, 'synced_or_skipped') };
      delete stOk.ext_fetch_error;
      const { error: upErr } = await supabase
        .from('bom_rows')
        .update({
          bom_row: nextBom,
          status: stOk,
        })
        .eq('id', rowId);
      if (upErr) throw upErr;

      nOk += 1;
      completed += 1;
      log('ext-sync row ok', {
        jobId,
        rowId,
        md5: md5Lower,
        syncKind,
        extUrl: targetDl,
      });
      const rowRetryTag = rowRetries ? ` (重试${rowRetries})` : '';
      await patchExtSyncJob(supabase, jobId, {
        progress_current: completed,
        running_row_id: null,
        heartbeat_at: new Date().toISOString(),
        last_message: `${completed}/${total} OK ${syncKind} ${fileName}${rowRetryTag}`.slice(0, 2000),
      });
    } catch (e) {
      const aborted =
        rowSignal.aborted ||
        (e instanceof Error &&
          (e.name === 'AbortError' || String(e.message).toLowerCase().includes('aborted')));
      if (aborted) {
        userCancelled = true;
        log('ext-sync row aborted', { jobId, rowId });
        break;
      }
      const msg = (e instanceof Error ? e.message : String(e)).slice(0, 1000);
      nFail += 1;
      completed += 1;
      log('ext-sync row error', {
        jobId,
        rowId,
        md5: md5Lower,
        error: msg,
      });
      await patchBomRowExtStatus(supabase, rowId, 'error', msg);
      await patchExtSyncJob(supabase, jobId, {
        progress_current: completed,
        running_row_id: null,
        heartbeat_at: new Date().toISOString(),
        last_message: `${completed}/${total} 失败 ${msg}`.slice(0, 2000),
      });
    } finally {
      currentRowAbort = null;
    }
  }

  if (userCancelled) {
    await patchExtSyncJob(supabase, jobId, {
      status: 'cancelled',
      finished_at: new Date().toISOString(),
      last_message: `用户取消（已完成 ${completed}/${total}）`.slice(0, 2000),
      cancel_requested: false,
      running_row_id: null,
    });
    log('ext-sync-job cancelled', jobId);
    return;
  }

  let finalStatus = 'succeeded';
  const retryNote = nRetries > 0 ? `，重试 ${nRetries}` : '';
  let summary = `完成：成功 ${nOk}，失败 ${nFail}，跳过 ${nSkip}${retryNote}`;
  if (nOk === 0 && nFail > 0) finalStatus = 'failed';
  else if (nOk > 0 && nFail > 0) summary = `部分失败：成功 ${nOk}，失败 ${nFail}，跳过 ${nSkip}${retryNote}`;

  await patchExtSyncJob(supabase, jobId, {
    status: finalStatus,
    finished_at: new Date().toISOString(),
    last_message: summary.slice(0, 2000),
    running_row_id: null,
    cancel_requested: false,
  });
  log('ext-sync-job done', jobId, summary);
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
export async function drainExtSyncJobs(supabase, rootAbs, tuning) {
  for (;;) {
    const { data, error } = await supabase.rpc('bom_claim_ext_sync_job');
    if (error) {
      log('WARN bom_claim_ext_sync_job', error.message);
      break;
    }
    const rows = Array.isArray(data) ? data : data ? [data] : [];
    const first = rows[0];
    if (!first?.id) break;
    try {
      await executeExtSyncJob(
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
      log('ERROR executeExtSyncJob', first.id, msg);
      await patchExtSyncJob(supabase, first.id, {
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
export async function failStaleExtSyncJobs(supabase, staleSec) {
  const sec = Number.isFinite(staleSec) && staleSec >= 60 ? Math.floor(staleSec) : 900;
  const { data, error } = await supabase.rpc('bom_fail_stale_ext_sync_jobs', { p_stale_seconds: sec });
  if (error) {
    log('WARN bom_fail_stale_ext_sync_jobs', error.message);
    return;
  }
  const n = typeof data === 'number' ? data : Number(data);
  if (n > 0) log('bom_fail_stale_ext_sync_jobs', n);
}
