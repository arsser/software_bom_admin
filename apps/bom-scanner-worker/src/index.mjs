import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { createClient } from '@supabase/supabase-js';
import { drainExtSyncJobs, failStaleExtSyncJobs } from './extArtifactorySync.mjs';
import { drainFeishuUploadJobs, failStaleFeishuUploadJobs } from './feishuUpload.mjs';
import {
  fetchBomScannerWorkerConfig,
  isRetriableSettingsFetchError,
  resolveWorkerTuning,
  WORKER_DB_RETRY_MS,
  IDLE_POLL_MS,
  JOB_STALE_SECONDS,
  SCAN_STALE_SECONDS,
} from './workerTuning.mjs';
import { patchBomRowLocalStatus } from './bomRowStatusJson.mjs';
import { reportBomLocalRootRuntime } from './workerRuntimeReport.mjs';

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const MAX_HTTP_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 3000;

/** 网络或 5xx 错误可重试；4xx / 取消 / 超时不重试 */
function isRetriableHttpError(e) {
  if (!e || typeof e !== 'object') return false;
  const msg = String(e.message || '').toLowerCase();
  if (e.name === 'AbortError' || msg === 'aborted') return false;
  if (msg.includes('timeout')) return false;
  if (msg.includes('fetch failed') || msg.includes('econnreset') || msg.includes('econnrefused') ||
      msg.includes('epipe') || msg.includes('socket hang up') || msg.includes('network')) return true;
  const httpMatch = msg.match(/^http (\d+)/);
  if (httpMatch) {
    const code = Number(httpMatch[1]);
    return code >= 500 || code === 408 || code === 429;
  }
  return false;
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v || !String(v).trim()) {
    throw new Error(`Missing required env: ${name}`);
  }
  return String(v).trim();
}

/** @param {string} filePath */
async function md5File(filePath) {
  const hash = createHash('md5');
  const stream = createReadStream(filePath);
  for await (const chunk of stream) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

/** @param {string} dir */
async function* walkFiles(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (e) {
    log('WARN readdir failed', dir, e instanceof Error ? e.message : e);
    return;
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      yield* walkFiles(full);
    } else if (ent.isFile()) {
      yield full;
    } else if (ent.isSymbolicLink()) {
      try {
        const st = await fs.stat(full);
        if (st.isFile()) yield full;
      } catch {
        /* skip broken symlink */
      }
    }
  }
}

function mtimeCloseEnough(dbIso, fileMtimeMs) {
  if (!dbIso) return false;
  const dbMs = Date.parse(dbIso);
  if (!Number.isFinite(dbMs)) return false;
  return Math.abs(dbMs - fileMtimeMs) < 2000;
}

/** @param {unknown} v */
function isValidMd5Hex(v) {
  return typeof v === 'string' && /^[a-f0-9]{32}$/i.test(v.trim());
}

/** @param {unknown} dbVal @param {number} diskSize */
function sizeBytesEqual(dbVal, diskSize) {
  if (dbVal == null) return false;
  try {
    return BigInt(String(dbVal)) === BigInt(Math.trunc(diskSize));
  } catch {
    return Number(dbVal) === diskSize;
  }
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} relPath
 */
async function fetchLocalFileRow(supabase, relPath) {
  const { data, error } = await supabase
    .from('local_file')
    .select('size_bytes,mtime,md5')
    .eq('path', relPath)
    .maybeSingle();
  if (error) throw error;
  return data;
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 */
async function pickQueuedJob(supabase) {
  const { data, error } = await supabase
    .from('bom_scan_jobs')
    .select('id')
    .eq('status', 'queued')
    .order('requested_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data?.id ?? null;
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 */
async function hasActiveScanJob(supabase) {
  const { data, error } = await supabase
    .from('bom_scan_jobs')
    .select('id')
    .in('status', ['queued', 'running'])
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return Boolean(data?.id);
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 */
async function lastSucceededFinishedAt(supabase) {
  const { data, error } = await supabase
    .from('bom_scan_jobs')
    .select('finished_at')
    .eq('status', 'succeeded')
    .order('finished_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data?.finished_at ? Date.parse(String(data.finished_at)) : 0;
}

/**
 * running 过久未结束（worker 崩溃等）会阻塞 bom_request_scan；与下载任务类似，定期标记为 failed。
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {number} staleSec
 */
async function failStaleScanJobs(supabase, staleSec) {
  const sec = Number.isFinite(staleSec) && staleSec >= 300 ? Math.floor(staleSec) : 7200;
  const { data, error } = await supabase.rpc('bom_fail_stale_scan_jobs', { p_stale_seconds: sec });
  if (error) {
    log('WARN bom_fail_stale_scan_jobs', error.message);
    return 0;
  }
  const n = typeof data === 'number' ? data : 0;
  if (n > 0) log('bom_fail_stale_scan_jobs', n, 'cutoffSec=', sec);
  return n;
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} jobId
 * @param {string} rootAbs
 * @param {import('./workerTuning.mjs').WorkerTuning} tuning
 */
async function runScanJob(supabase, jobId, rootAbs, tuning) {
  let filesSeen = 0;
  let filesMd5Updated = 0;

  const { error: startErr } = await supabase.rpc('bom_mark_scan_started', {
    p_job_id: jobId,
    p_message: 'scanning',
  });
  if (startErr) throw startErr;

  let globalHbTimer = null;
  try {
    await reportBomLocalRootRuntime(supabase, rootAbs, { phase: 'busy', busyHint: 'scan' });
    globalHbTimer = setInterval(() => {
      void reportBomLocalRootRuntime(supabase, rootAbs, { phase: 'busy', busyHint: 'scan' });
    }, tuning.heartbeatMs);

  for await (const abs of walkFiles(rootAbs)) {
    const rel = path.relative(rootAbs, abs).split(path.sep).join('/');
    if (!rel || rel.startsWith('..')) continue;

    let st;
    try {
      st = await fs.stat(abs);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;

    filesSeen += 1;
    const sizeBytes = st.size;
    const mtimeIso = new Date(st.mtimeMs).toISOString();

    const existing = await fetchLocalFileRow(supabase, rel);
    const sizeSame = Boolean(existing && sizeBytesEqual(existing.size_bytes, sizeBytes));
    const mtimeSame = Boolean(existing && mtimeCloseEnough(existing.mtime, st.mtimeMs));
    const hasMd5 = Boolean(existing && isValidMd5Hex(existing.md5));
    const needMd5 = !existing || !sizeSame || !mtimeSame || !hasMd5;

    let md5Hex = null;
    if (needMd5) {
      try {
        md5Hex = await md5File(abs);
        filesMd5Updated += 1;
      } catch (e) {
        log('WARN md5 failed', rel, e instanceof Error ? e.message : e);
      }
    }

    const { error: upErr } = await supabase.rpc('bom_upsert_local_file', {
      p_job_id: jobId,
      p_path: rel,
      p_size_bytes: sizeBytes,
      p_mtime: mtimeIso,
      p_md5: md5Hex,
    });
    if (upErr) throw upErr;
  }

  const summary = `files_seen=${filesSeen} md5_updated=${filesMd5Updated}`;
  const { data: finRows, error: finErr } = await supabase.rpc('bom_finalize_scan', {
    p_job_id: jobId,
    p_success: true,
    p_files_seen: filesSeen,
    p_files_md5_updated: filesMd5Updated,
    p_files_removed: 0,
    p_message: summary,
    p_prune_missing: true,
  });
  if (finErr) throw finErr;
  const fr = Array.isArray(finRows) && finRows[0] ? finRows[0] : null;
  log(
    'job done',
    jobId,
    summary,
    fr ? `prune_removed=${fr.removed_count} bom_status_updates=${fr.status_updates}` : '(no finalize row)',
  );
  const { data: sizeSynced, error: sizeSyncErr } = await supabase.rpc('bom_sync_bom_row_local_size_from_index');
  if (sizeSyncErr) {
    log('WARN bom_sync_bom_row_local_size_from_index', sizeSyncErr.message);
  } else {
    log('bom_row local size synced rows_updated=', sizeSynced ?? 0);
  }
  } finally {
    if (globalHbTimer) clearInterval(globalHbTimer);
    await reportBomLocalRootRuntime(supabase, rootAbs, { phase: 'idle' });
  }
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} jobId
 * @param {string} message
 */
async function failJob(supabase, jobId, message) {
  const { error } = await supabase.rpc('bom_finalize_scan', {
    p_job_id: jobId,
    p_success: false,
    p_files_seen: 0,
    p_files_md5_updated: 0,
    p_files_removed: 0,
    p_message: message.slice(0, 2000),
    p_prune_missing: false,
  });
  if (error) log('WARN failJob finalize error', error.message);
}


/** @param {string} raw */
function urlPathBasename(raw) {
  if (!raw || !String(raw).trim()) return '';
  try {
    const u = new URL(String(raw).trim());
    const seg = u.pathname.split('/').filter(Boolean);
    return seg.length ? seg[seg.length - 1] : '';
  } catch {
    const t = String(raw).trim().replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i, '').replace(/\?.*$/, '');
    const parts = t.split('/');
    return parts.length ? parts[parts.length - 1] : '';
  }
}

/** @param {string} name */
function safeFlatFilename(name) {
  const base = name && String(name).trim() ? String(name).trim() : 'download.bin';
  const cleaned = base.replace(/[/\\?*:|"<>]/g, '_').replace(/\s+/g, ' ');
  return cleaned.slice(0, 200) || 'download.bin';
}

/** 日志用：不输出完整密钥 */
function apiKeyLogHint(key) {
  const k = String(key ?? '').trim();
  if (!k) return { present: false, length: 0, hint: '(empty)' };
  const len = k.length;
  const hint = len <= 8 ? `***(len=${len})` : `${k.slice(0, 4)}…${k.slice(-2)}(len=${len})`;
  return { present: true, length: len, hint };
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @returns {Promise<{ primary: { apiKey: string, baseUrl: string }, ext: { apiKey: string, baseUrl: string } }>}
 */
async function loadItArtifactoryDbBundle(supabase) {
  const { data, error } = await supabase
    .from('system_settings')
    .select('value')
    .eq('key', 'artifactory_config')
    .maybeSingle();
  if (error) {
    log('WARN load artifactory_config', error.message);
    return {
      primary: { apiKey: '', baseUrl: '' },
      ext: { apiKey: '', baseUrl: '' },
    };
  }
  const v = data?.value ?? {};
  return {
    primary: {
      apiKey: typeof v.artifactoryApiKey === 'string' ? v.artifactoryApiKey.trim() : '',
      baseUrl: typeof v.artifactoryBaseUrl === 'string' ? v.artifactoryBaseUrl.trim() : '',
    },
    ext: {
      apiKey: typeof v.artifactoryExtApiKey === 'string' ? v.artifactoryExtApiKey.trim() : '',
      baseUrl: typeof v.artifactoryExtBaseUrl === 'string' ? v.artifactoryExtBaseUrl.trim() : '',
    },
  };
}

function itDbBundleHasAnyKey(bundle) {
  return Boolean(bundle.primary.apiKey || bundle.ext.apiKey);
}

/**
 * 按下载 URL 主机与 DB 中 base URL 匹配内部/外部 Artifactory。
 * @param {string} downloadUrl
 * @param {{ primary: { apiKey: string, baseUrl: string }, ext: { apiKey: string, baseUrl: string } }} bundle
 * @returns {{ apiKey: string, baseUrl: string } | null}
 */
function pickCredsForItUrl(downloadUrl, bundle) {
  const { primary, ext } = bundle;
  let u;
  try {
    u = new URL(downloadUrl);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  let extHost = null;
  let priHost = null;
  try {
    extHost = ext.baseUrl ? new URL(ext.baseUrl.includes('://') ? ext.baseUrl : `https://${ext.baseUrl}`).hostname.toLowerCase() : null;
  } catch {
    extHost = null;
  }
  try {
    priHost = primary.baseUrl ? new URL(primary.baseUrl.includes('://') ? primary.baseUrl : `https://${primary.baseUrl}`).hostname.toLowerCase() : null;
  } catch {
    priHost = null;
  }
  if (extHost && host === extHost && ext.apiKey) return { apiKey: ext.apiKey, baseUrl: ext.baseUrl };
  if (priHost && host === priHost && primary.apiKey) return { apiKey: primary.apiKey, baseUrl: primary.baseUrl };
  if (!priHost && !extHost) {
    if (primary.apiKey) return { apiKey: primary.apiKey, baseUrl: primary.baseUrl };
    if (ext.apiKey) return { apiKey: ext.apiKey, baseUrl: ext.baseUrl };
  }
  return null;
}

async function logItArtifactoryDbAtStartup(supabase) {
  const bundle = await loadItArtifactoryDbBundle(supabase);
  const ph = apiKeyLogHint(bundle.primary.apiKey);
  const eh = apiKeyLogHint(bundle.ext.apiKey);
  log('it-artifactory creds', {
    source: 'db',
    primaryApiKey: ph.hint,
    primaryBaseUrl: bundle.primary.baseUrl || '(empty)',
    extApiKey: eh.hint,
    extBaseUrl: bundle.ext.baseUrl || '(empty)',
    anyKey: itDbBundleHasAnyKey(bundle),
  });
  if (!itDbBundleHasAnyKey(bundle)) {
    log('WARN it-artifactory DB artifactory_config 未配置内部/外部 API Key，队列拉取将失败');
  }
}

function itUrlAllowedForBase(downloadUrl, baseUrl) {
  if (!baseUrl) return true;
  try {
    const b = new URL(baseUrl.includes('://') ? baseUrl : `https://${baseUrl}`);
    const u = new URL(downloadUrl);
    return b.hostname === u.hostname;
  } catch {
    return true;
  }
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} jobId
 * @param {Record<string, unknown>} patch
 */
async function patchDownloadJob(supabase, jobId, patch) {
  const { error } = await supabase.from('bom_download_jobs').update(patch).eq('id', jobId);
  if (error) log('WARN patchDownloadJob', jobId, error.message);
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} rootAbs
 * @param {{ apiKey: string, baseUrl: string }} creds
 * @param {{ id: string, downloadUrl: string }} row
 * @param {object} [opts]
 * @param {(n: { runningDownloaded: number, runningTotal: number | null, fileName: string }) => void} [opts.onProgress]
 * @param {AbortSignal} [opts.signal]
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.maxRetries]
 */
async function downloadItArtifactRow(supabase, rootAbs, creds, row, opts = {}) {
  const id = row.id;
  const url = String(row.downloadUrl).trim();
  const onProgress = opts.onProgress;
  const signal = opts.signal;
  const timeoutMs =
    typeof opts.timeoutMs === 'number' && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
      ? opts.timeoutMs
      : 3600000;
  const maxRetries =
    typeof opts.maxRetries === 'number' && Number.isFinite(opts.maxRetries) && opts.maxRetries >= 0
      ? opts.maxRetries
      : MAX_HTTP_RETRIES;
  if (!/^https?:\/\//i.test(url)) {
    return { ok: false, message: '非 http(s) URL' };
  }

  if (!itUrlAllowedForBase(url, creds.baseUrl)) {
    const msg = `URL 主机与配置的 it Base URL 不一致`;
    log('it-download skip host mismatch', id, url);
    await patchBomRowLocalStatus(supabase, id, 'error', msg.slice(0, 1000));
    return { ok: false, message: msg };
  }

  let baseName = safeFlatFilename(urlPathBasename(url));
  let destName = baseName;
  let destAbs = path.join(rootAbs, destName);
  let n = 0;
  while (true) {
    try {
      await fs.access(destAbs);
      n += 1;
      const ext = path.extname(baseName);
      const stem = ext ? baseName.slice(0, -ext.length) : baseName;
      destName = `${stem}_${n}${ext || ''}`;
      destAbs = path.join(rootAbs, destName);
    } catch {
      break;
    }
  }

  const tmpAbs = `${destAbs}.part`;
  let urlHost = '';
  let urlPathPrefix = '';
  try {
    const u = new URL(url);
    urlHost = u.hostname;
    urlPathPrefix = u.pathname.length > 120 ? `${u.pathname.slice(0, 120)}…` : u.pathname;
  } catch (e) {
    log('WARN it-download URL parse', id, e instanceof Error ? e.message : e);
  }
  const hostOk = itUrlAllowedForBase(url, creds.baseUrl);
  log('it-download fetch', id, {
    urlHost,
    pathPrefix: urlPathPrefix,
    destFile: destName,
    configuredBaseUrl: creds.baseUrl || '(none)',
    hostMatchesBase: hostOk,
    auth: 'Bearer + X-JFrog-Art-Api (same key; JFrog 通常认后者)',
  });

  let retries = 0;
  try {
    let totalBytes = null;
    const doFetch = async () => {
      totalBytes = null;
      const key = creds.apiKey;
      const res = await fetch(url, {
        signal,
        redirect: 'follow',
        headers: {
          Authorization: `Bearer ${key}`,
          'X-JFrog-Art-Api': key,
          'X-Api-Key': key,
          Accept: '*/*',
        },
      });
      if (!res.ok) {
        let bodySnippet = '';
        try {
          bodySnippet = (await res.text()).slice(0, 400).replace(/\s+/g, ' ');
        } catch {
          /* ignore */
        }
        const wwwAuth = res.headers.get('www-authenticate');
        const reqId = res.headers.get('x-request-id') || res.headers.get('x-jfrog-request-id');
        log('it-download http error', id, {
          status: res.status,
          statusText: res.statusText,
          wwwAuthenticate: wwwAuth,
          requestId: reqId,
          bodySnippet: bodySnippet || '(empty)',
        });
        const msg = `HTTP ${res.status} ${res.statusText || ''}`.trim().slice(0, 1000);
        throw new Error(msg);
      }
      if (!res.body) throw new Error('响应无正文');
      const cl = res.headers.get('content-length');
      if (cl) {
        const parsed = Number(cl);
        if (Number.isFinite(parsed) && parsed >= 0) totalBytes = parsed;
      }
      const ws = createWriteStream(tmpAbs, { flags: 'w' });
      let running = 0;
      const counter = new Transform({
        transform(chunk, _enc, cb) {
          running += chunk.length;
          if (onProgress) {
            onProgress({ runningDownloaded: running, runningTotal: totalBytes, fileName: destName });
          }
          cb(null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(res.body), counter, ws);
    };

    for (let attempt = 0; ; attempt++) {
      try {
        await Promise.race([
          doFetch(),
          new Promise((_, reject) => { setTimeout(() => reject(new Error('download timeout')), timeoutMs); }),
        ]);
        break;
      } catch (fetchErr) {
        try { await fs.unlink(tmpAbs); } catch { /* ignore */ }
        if (signal?.aborted) throw fetchErr;
        if (attempt >= maxRetries || !isRetriableHttpError(fetchErr)) throw fetchErr;
        retries += 1;
        const delay = RETRY_BASE_DELAY_MS * (attempt + 1);
        log('it-download retry', id, `attempt ${attempt + 1}/${maxRetries}`, fetchErr.message, `wait ${delay}ms`);
        await sleep(delay);
      }
    }
    let fileSize = 0;
    try {
      const st = await fs.stat(tmpAbs);
      fileSize = st.size;
    } catch {
      fileSize = 0;
    }
    await fs.rename(tmpAbs, destAbs);
    log('it-download ok', id, destName);

    const relPath = destName.split(path.sep).join('/');
    let md5Hex = null;
    try {
      md5Hex = await md5File(destAbs);
    } catch (e) {
      log('WARN it-download md5', id, e instanceof Error ? e.message : e);
    }
    let mtimeIso = new Date().toISOString();
    try {
      const stFinal = await fs.stat(destAbs);
      mtimeIso = new Date(stFinal.mtimeMs).toISOString();
    } catch {
      /* keep default */
    }
    const { error: upLfErr } = await supabase.rpc('bom_upsert_local_file_web', {
      p_path: relPath,
      p_size_bytes: fileSize,
      p_mtime: mtimeIso,
      p_md5: md5Hex,
    });
    if (upLfErr) {
      log('WARN bom_upsert_local_file_web', id, upLfErr.message);
    }
    const { error: refErr } = await supabase.rpc('bom_refresh_local_found_statuses');
    if (refErr) {
      log('WARN bom_refresh after it-download', id, refErr.message);
    }

    return { ok: true, fileName: destName, bytes: fileSize, retries };
  } catch (e) {
    try {
      await fs.unlink(tmpAbs);
    } catch {
      /* ignore */
    }
    const aborted =
      (signal && signal.aborted) ||
      (e instanceof Error && (e.name === 'AbortError' || e.message === 'aborted'));
    if (aborted) {
      log('it-download aborted', id);
      return { ok: false, message: '用户取消', cancelled: true, retries };
    }
    const msg = (e instanceof Error ? e.message : String(e)).slice(0, 1000);
    log('it-download error', id, msg);
    await patchBomRowLocalStatus(supabase, id, 'error', msg);
    return { ok: false, message: msg, retries };
  }
}


/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {number} staleSec
 */
async function failStaleDownloadJobs(supabase, staleSec) {
  const sec = Number.isFinite(staleSec) && staleSec >= 60 ? Math.floor(staleSec) : 900;
  const { data, error } = await supabase.rpc('bom_fail_stale_download_jobs', { p_stale_seconds: sec });
  if (error) {
    log('WARN bom_fail_stale_download_jobs', error.message);
    return;
  }
  const n = typeof data === 'number' ? data : Number(data);
  if (n > 0) log('bom_fail_stale_download_jobs', n);
}

/** @param {import('@supabase/supabase-js').SupabaseClient} supabase @param {string} jobId */
async function isDownloadJobCancelRequested(supabase, jobId) {
  const { data, error } = await supabase
    .from('bom_download_jobs')
    .select('cancel_requested')
    .eq('id', jobId)
    .maybeSingle();
  if (error) {
    log('WARN cancel_requested read', error.message);
    return false;
  }
  return Boolean(data?.cancel_requested);
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 */
async function claimDownloadJob(supabase) {
  const { data, error } = await supabase.rpc('bom_claim_download_job');
  if (error) {
    log('WARN bom_claim_download_job', error.message);
    return null;
  }
  if (data == null) return null;
  const rows = Array.isArray(data) ? data : [data];
  const first = rows[0];
  if (!first?.id) return null;
  const pull = first.pull_url_source ?? first.pullUrlSource;
  return {
    ...first,
    pull_url_source: typeof pull === 'string' && pull.trim() ? pull.trim() : 'download',
  };
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} rootAbs
 * @param {{ id: string, row_ids: string[], progress_total: number, pull_url_source?: string }} job
 * @param {import('./workerTuning.mjs').WorkerTuning} tuning
 */
async function executeDownloadJob(supabase, rootAbs, job, tuning) {
  const jobId = job.id;
  const rowIds = Array.isArray(job.row_ids) ? job.row_ids : [];
  const total = rowIds.length;
  const heartbeatMs = tuning.heartbeatMs;

  if (!total) {
    await patchDownloadJob(supabase, jobId, {
      status: 'failed',
      finished_at: new Date().toISOString(),
      last_message: '任务无行',
      cancel_requested: false,
    });
    return;
  }

  const itBundle = await loadItArtifactoryDbBundle(supabase);
  if (!itDbBundleHasAnyKey(itBundle)) {
    await patchDownloadJob(supabase, jobId, {
      status: 'failed',
      finished_at: new Date().toISOString(),
      last_message:
        '未配置 it Artifactory API Key（请在数据库 system_settings.artifactory_config 配置内部/外部 Key）',
      cancel_requested: false,
    });
    return;
  }

  const extOnly = String(job.pull_url_source ?? 'download').toLowerCase() === 'ext_only';
  const targetsRpc = extOnly ? 'bom_row_distribute_ext_pull_targets' : 'bom_row_download_targets';
  const { data: targets, error: tErr } = await supabase.rpc(targetsRpc, { p_ids: rowIds });
  if (tErr) {
    await patchDownloadJob(supabase, jobId, {
      status: 'failed',
      finished_at: new Date().toISOString(),
      last_message: tErr.message.slice(0, 2000),
      cancel_requested: false,
    });
    return;
  }

  const urlMap = new Map((targets ?? []).map((t) => [t.id, t.download_url]));

  await reportBomLocalRootRuntime(supabase, rootAbs, { phase: 'busy', busyHint: 'it-download' });
  let heartbeatTimer = null;
  /** @type {AbortController | null} */
  let currentRowAbort = null;
  const touchHeartbeat = async () => {
    await patchDownloadJob(supabase, jobId, {
      heartbeat_at: new Date().toISOString(),
    });
  };
  heartbeatTimer = setInterval(() => {
    void touchHeartbeat();
    void reportBomLocalRootRuntime(supabase, rootAbs, { phase: 'busy', busyHint: 'it-download' });
    void (async () => {
      if (await isDownloadJobCancelRequested(supabase, jobId)) {
        if (currentRowAbort) currentRowAbort.abort();
      }
    })();
  }, heartbeatMs);

  let completed = 0;
  let nOk = 0;
  let nFail = 0;
  let nSkip = 0;
  let nRetries = 0;
  let bytesDoneTotal = 0;
  let userCancelled = false;

  try {
    for (const rowId of rowIds) {
      if (await isDownloadJobCancelRequested(supabase, jobId)) {
        userCancelled = true;
        break;
      }

      const stillRpc = extOnly ? 'bom_row_still_eligible_for_distribute_ext_pull' : 'bom_row_still_eligible_for_it_download';
      const { data: still, error: e1 } = await supabase.rpc(stillRpc, { p_row_id: rowId });
      if (e1) log('WARN bom_row_still_eligible', e1.message);

      if (!still) {
        nSkip += 1;
        completed += 1;
        await patchDownloadJob(supabase, jobId, {
          progress_current: completed,
          running_row_id: null,
          running_file_name: null,
          running_bytes_downloaded: 0,
          running_bytes_total: null,
          last_message: `${completed}/${total} 跳过（已有本地或状态变化）`,
        });
        await touchHeartbeat();
        continue;
      }

      const rawUrl = urlMap.get(rowId);
      const url = typeof rawUrl === 'string' ? rawUrl.trim() : '';
      if (!url) {
        nSkip += 1;
        completed += 1;
        await patchDownloadJob(supabase, jobId, {
          progress_current: completed,
          running_row_id: null,
          running_file_name: null,
          running_bytes_downloaded: 0,
          running_bytes_total: null,
          last_message: `${completed}/${total} 跳过（无下载 URL）`,
        });
        await touchHeartbeat();
        continue;
      }

      const destNameGuess = safeFlatFilename(urlPathBasename(url));
      let lastFlush = 0;
      await patchDownloadJob(supabase, jobId, {
        running_row_id: rowId,
        running_file_name: destNameGuess,
        running_bytes_downloaded: 0,
        running_bytes_total: null,
        last_message: `${completed}/${total} 下载中… ${destNameGuess}`,
      });
      await touchHeartbeat();

      const rowCreds = pickCredsForItUrl(url, itBundle);
      if (!rowCreds?.apiKey) {
        const msg =
          '环境变量中的 IT_ARTIFACTORY_BASE_URL / IT_ARTIFACTORY_EXT_BASE_URL 与下载 URL 主机无法匹配（或对应 Key 为空）';
        nFail += 1;
        completed += 1;
        await patchBomRowLocalStatus(supabase, rowId, 'error', msg.slice(0, 1000));
        await patchDownloadJob(supabase, jobId, {
          progress_current: completed,
          bytes_downloaded_total: bytesDoneTotal,
          running_row_id: null,
          running_file_name: null,
          running_bytes_downloaded: 0,
          running_bytes_total: null,
          last_message: `${completed}/${total} ${msg}`.slice(0, 2000),
        });
        await touchHeartbeat();
        continue;
      }

      currentRowAbort = new AbortController();
      const r = await downloadItArtifactRow(supabase, rootAbs, rowCreds, { id: rowId, downloadUrl: url }, {
        signal: currentRowAbort.signal,
        timeoutMs: tuning.httpTimeoutMs,
        maxRetries: tuning.httpRetries,
        onProgress: ({ runningDownloaded, runningTotal, fileName }) => {
          const now = Date.now();
          if (now - lastFlush < heartbeatMs) return;
          lastFlush = now;
          const msg =
            runningTotal != null
              ? `${completed + 1}/${total} 下载中 ${fileName} ${runningDownloaded}/${runningTotal} B`
              : `${completed + 1}/${total} 下载中 ${fileName} ${runningDownloaded} B`;
          void patchDownloadJob(supabase, jobId, {
            running_bytes_downloaded: runningDownloaded,
            running_bytes_total: runningTotal,
            running_file_name: fileName,
            heartbeat_at: new Date().toISOString(),
            last_message: msg.slice(0, 2000),
          });
        },
      });
      currentRowAbort = null;

      if (r.retries) nRetries += r.retries;

      if (r.cancelled) {
        userCancelled = true;
        break;
      }

      if (r.ok) {
        nOk += 1;
        const b = typeof r.bytes === 'number' ? r.bytes : 0;
        bytesDoneTotal += b;
      } else {
        nFail += 1;
      }
      completed += 1;
      const retryTag = r.retries ? ` (重试${r.retries})` : '';
      const tail = r.ok ? `→ ${r.fileName}${retryTag}` : `${r.message ?? '失败'}${retryTag}`;
      await patchDownloadJob(supabase, jobId, {
        progress_current: completed,
        bytes_downloaded_total: bytesDoneTotal,
        running_row_id: null,
        running_file_name: null,
        running_bytes_downloaded: 0,
        running_bytes_total: null,
        last_message: `${completed}/${total} ${tail}`.slice(0, 2000),
      });
      await touchHeartbeat();
    }

    if (userCancelled) {
      await patchDownloadJob(supabase, jobId, {
        status: 'cancelled',
        finished_at: new Date().toISOString(),
        last_message: `用户取消（已完成 ${completed}/${total}）`.slice(0, 2000),
        cancel_requested: false,
        running_row_id: null,
        running_file_name: null,
        running_bytes_downloaded: 0,
        running_bytes_total: null,
        bytes_downloaded_total: bytesDoneTotal,
        progress_current: completed,
      });
      log('web-download-job cancelled', jobId);
      return;
    }

    let finalStatus = 'succeeded';
    const retryNote = nRetries > 0 ? `，重试 ${nRetries}` : '';
    let summary = `完成：成功 ${nOk}，失败 ${nFail}，跳过 ${nSkip}${retryNote}`;
    if (nOk === 0 && nFail > 0) {
      finalStatus = 'failed';
    } else if (nOk > 0 && nFail > 0) {
      summary = `部分失败：成功 ${nOk}，失败 ${nFail}，跳过 ${nSkip}${retryNote}`;
    }

    await patchDownloadJob(supabase, jobId, {
      status: finalStatus,
      finished_at: new Date().toISOString(),
      last_message: summary.slice(0, 2000),
      cancel_requested: false,
      running_row_id: null,
      running_file_name: null,
      running_bytes_downloaded: 0,
      running_bytes_total: null,
    });
    log('web-download-job done', jobId, summary);
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    currentRowAbort = null;
    await reportBomLocalRootRuntime(supabase, rootAbs, { phase: 'idle' });
  }
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} rootAbs
 */
/** 距上次「磁盘缺失则删索引」的最小间隔，避免与主循环、idle 轮询叠加重试 */
let lastPruneMissingOnDiskAt = 0;
const PRUNE_MISSING_MIN_MS = 12000;

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} rootAbs
 * @param {import('./workerTuning.mjs').WorkerTuning} tuning
 */
async function drainWebDownloadJobs(supabase, rootAbs, tuning) {
  for (;;) {
    const job = await claimDownloadJob(supabase);
    if (!job) break;
    try {
      await executeDownloadJob(supabase, rootAbs, job, tuning);
    } catch (e) {
      const msg = (e instanceof Error ? e.message : String(e)).slice(0, 2000);
      log('ERROR executeDownloadJob', job.id, msg);
      await patchDownloadJob(supabase, job.id, {
        status: 'failed',
        finished_at: new Date().toISOString(),
        last_message: msg,
        running_row_id: null,
        running_file_name: null,
        cancel_requested: false,
      });
    }
  }
}

/**
 * 删除索引中磁盘已不存在的文件记录，并刷新 bom_rows 状态。
 * 解决：手动删除暂存文件后，在下次全量扫描 finalize 之前 local_file 仍保留 MD5，界面长期显示「校验通过」。
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} rootAbs
 * @param {number} [limit]
 */
async function pruneLocalIndexEntriesMissingOnDisk(supabase, rootAbs, limit = 400) {
  const now = Date.now();
  if (now - lastPruneMissingOnDiskAt < PRUNE_MISSING_MIN_MS) return 0;
  lastPruneMissingOnDiskAt = now;

  const lim = Math.min(Math.max(Number(limit) || 400, 1), 800);
  const { data, error } = await supabase
    .from('local_file')
    .select('path')
    .order('updated_at', { ascending: true })
    .limit(lim);
  if (error) {
    log('WARN prune-missing select', error.message);
    return 0;
  }
  const rows = data ?? [];
  const missing = [];
  for (const r of rows) {
    const rel = r?.path;
    if (!rel || typeof rel !== 'string') continue;
    const t = rel.trim();
    if (!t || t.includes('..')) continue;
    const abs = path.join(rootAbs, t.split('/').join(path.sep));
    try {
      const st = await fs.stat(abs);
      if (!st.isFile()) missing.push(t);
    } catch {
      missing.push(t);
    }
  }
  if (missing.length === 0) return 0;

  let removed = 0;
  const chunkSize = 80;
  for (let i = 0; i < missing.length; i += chunkSize) {
    const chunk = missing.slice(i, i + chunkSize);
    const { error: delErr } = await supabase.from('local_file').delete().in('path', chunk);
    if (delErr) {
      log('WARN prune-missing delete', delErr.message);
      continue;
    }
    removed += chunk.length;
  }
  if (removed > 0) {
    const { error: refErr } = await supabase.rpc('bom_refresh_local_found_statuses');
    if (refErr) log('WARN prune-missing bom_refresh', refErr.message);
    else log('prune-missing-on-disk', removed, 'local_file rows removed');
  }
  return removed;
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} rootAbs
 * @param {number} intervalMs
 * @param {import('./workerTuning.mjs').WorkerTuning} tuning
 */
async function sleepWithDownloadPoll(supabase, rootAbs, intervalMs, tuning) {
  let remaining = intervalMs;
  while (remaining > 0) {
    try {
      await failStaleExtSyncJobs(supabase, JOB_STALE_SECONDS);
      await failStaleFeishuUploadJobs(supabase, JOB_STALE_SECONDS);
      await failStaleDownloadJobs(supabase, JOB_STALE_SECONDS);
      await failStaleScanJobs(supabase, SCAN_STALE_SECONDS);
      await drainWebDownloadJobs(supabase, rootAbs, tuning);
      await drainExtSyncJobs(supabase, rootAbs, tuning);
      await drainFeishuUploadJobs(supabase, rootAbs, tuning);
      try {
        await pruneLocalIndexEntriesMissingOnDisk(supabase, rootAbs, 300);
      } catch (e) {
        log('WARN idle prune-missing-on-disk', e instanceof Error ? e.message : e);
      }
    } catch (e) {
      log('WARN idle download poll', e instanceof Error ? e.message : e);
    }
    const nap = Math.min(IDLE_POLL_MS, remaining);
    await sleep(nap);
    remaining -= nap;
  }
}


async function main() {
  const url = requireEnv('SUPABASE_URL');
  const key = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  const root = requireEnv('BOM_LOCAL_ROOT');

  let rootAbs = path.resolve(root);
  try {
    await fs.access(rootAbs, fs.constants.R_OK | fs.constants.W_OK);
  } catch (e) {
    throw new Error(`BOM_LOCAL_ROOT not readable/writable: ${rootAbs} (${e instanceof Error ? e.message : e})`);
  }

  const supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  log('bom-scanner-worker start', {
    root: rootAbs,
    cwd: process.cwd(),
    note:
      'scan interval + workerTuning from system_settings.bom_scanner; downloads bom_download_jobs; ext bom_ext_sync_jobs; feishu bom_feishu_upload_jobs',
  });

  await logItArtifactoryDbAtStartup(supabase);
  await reportBomLocalRootRuntime(supabase, rootAbs, { phase: 'idle' });

  while (true) {
    let intervalSec = 30;
    let tuning = resolveWorkerTuning(null);
    try {
      const cfg = await fetchBomScannerWorkerConfig(supabase);
      intervalSec = cfg.intervalSec;
      tuning = cfg.tuning;
    } catch (e) {
      log('WARN fetch bom_scanner', e instanceof Error ? e.message : e);
      if (isRetriableSettingsFetchError(e)) {
        await sleep(WORKER_DB_RETRY_MS);
        continue;
      }
    }

    try {
      await reportBomLocalRootRuntime(supabase, rootAbs, { phase: 'idle' });

      await failStaleExtSyncJobs(supabase, JOB_STALE_SECONDS);
      await failStaleFeishuUploadJobs(supabase, JOB_STALE_SECONDS);
      await failStaleDownloadJobs(supabase, JOB_STALE_SECONDS);
      await failStaleScanJobs(supabase, SCAN_STALE_SECONDS);
      await drainWebDownloadJobs(supabase, rootAbs, tuning);
      await drainExtSyncJobs(supabase, rootAbs, tuning);
      await drainFeishuUploadJobs(supabase, rootAbs, tuning);

      try {
        await pruneLocalIndexEntriesMissingOnDisk(supabase, rootAbs);
      } catch (e) {
        log('WARN prune-missing-on-disk', e instanceof Error ? e.message : e);
      }

      let jobId = await pickQueuedJob(supabase);
      while (jobId) {
        try {
          await runScanJob(supabase, jobId, rootAbs, tuning);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          log('ERROR job failed', jobId, msg);
          await failJob(supabase, jobId, msg);
        }
        jobId = await pickQueuedJob(supabase);
      }

      const active = await hasActiveScanJob(supabase);
      if (!active) {
        const lastOk = await lastSucceededFinishedAt(supabase);
        const due = lastOk === 0 || Date.now() - lastOk >= intervalSec * 1000;
        if (due) {
          const { data: newId, error: reqErr } = await supabase.rpc('bom_request_scan', { p_trigger_source: 'scheduler' });
          if (reqErr) log('WARN scheduler enqueue', reqErr.message);
          else log('scheduler enqueued', newId);
        }
      }
    } catch (e) {
      log('ERROR tick', e instanceof Error ? e.stack : e);
    }
    await sleepWithDownloadPoll(supabase, rootAbs, intervalSec * 1000, tuning);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

