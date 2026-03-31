import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { createClient } from '@supabase/supabase-js';

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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
function clampScanSeconds(n) {
  if (!Number.isFinite(n)) return 30;
  return Math.min(86400, Math.max(5, Math.round(n)));
}

/**
 * 与 Web 设置一致：scanIntervalSeconds；兼容历史 scanIntervalMinutes
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 */
async function fetchScanIntervalSeconds(supabase) {
  const { data, error } = await supabase.from('system_settings').select('value').eq('key', 'bom_scanner').maybeSingle();
  if (error) {
    log('WARN fetch bom_scanner settings', error.message);
    return 30;
  }
  const v = data?.value;
  if (typeof v?.scanIntervalSeconds === 'number' && Number.isFinite(v.scanIntervalSeconds)) {
    return clampScanSeconds(v.scanIntervalSeconds);
  }
  if (typeof v?.scanIntervalMinutes === 'number' && Number.isFinite(v.scanIntervalMinutes)) {
    return clampScanSeconds(v.scanIntervalMinutes * 60);
  }
  return 30;
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
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} jobId
 * @param {string} rootAbs
 */
async function runScanJob(supabase, jobId, rootAbs) {
  let filesSeen = 0;
  let filesMd5Updated = 0;

  const { error: startErr } = await supabase.rpc('bom_mark_scan_started', {
    p_job_id: jobId,
    p_message: 'scanning',
  });
  if (startErr) throw startErr;

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
  const { error: finErr } = await supabase.rpc('bom_finalize_scan', {
    p_job_id: jobId,
    p_success: true,
    p_files_seen: filesSeen,
    p_files_md5_updated: filesMd5Updated,
    p_files_removed: 0,
    p_message: summary,
    p_prune_missing: true,
  });
  if (finErr) throw finErr;
  log('job done', jobId, summary);
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
 * 按下载 URL 主机与 DB 中 base URL 匹配主/扩展实例。
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
    log('WARN it-artifactory DB artifactory_config 未配置主/扩展 API Key，队列拉取将失败');
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
 */
async function downloadItArtifactRow(supabase, rootAbs, creds, row, opts = {}) {
  const id = row.id;
  const url = String(row.downloadUrl).trim();
  const onProgress = opts.onProgress;
  if (!/^https?:\/\//i.test(url)) {
    return { ok: false, message: '非 http(s) URL' };
  }

  if (!itUrlAllowedForBase(url, creds.baseUrl)) {
    const msg = `URL 主机与配置的 it Base URL 不一致`;
    log('it-download skip host mismatch', id, url);
    const { error: upErr } = await supabase
      .from('bom_rows')
      .update({ status: 'error', last_fetch_error: msg.slice(0, 1000) })
      .eq('id', id);
    if (upErr) log('WARN set fetch error', upErr.message);
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
  const timeoutMsRaw = Number(process.env.IT_ARTIFACTORY_DOWNLOAD_TIMEOUT_MS || 3600000);
  const timeoutMs = Number.isFinite(timeoutMsRaw) && timeoutMsRaw > 0 ? timeoutMsRaw : 3600000;
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

  try {
    let totalBytes = null;
    await Promise.race([
      (async () => {
        const key = creds.apiKey;
        const res = await fetch(url, {
          redirect: 'follow',
          headers: {
            // 与网页复制的 curl、artifactory-api-info Edge 一致：JFrog API Key 主要靠 X-JFrog-Art-Api；
            // 仅 Bearer 时部分实例会 401（Bad props auth token / basictoken=…）。
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
              onProgress({
                runningDownloaded: running,
                runningTotal: totalBytes,
                fileName: destName,
              });
            }
            cb(null, chunk);
          },
        });
        await pipeline(Readable.fromWeb(res.body), counter, ws);
      })(),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error('download timeout')), timeoutMs);
      }),
    ]);
    let fileSize = 0;
    try {
      const st = await fs.stat(tmpAbs);
      fileSize = st.size;
    } catch {
      fileSize = 0;
    }
    await fs.rename(tmpAbs, destAbs);
    log('it-download ok', id, destName);
    const { error: upErr } = await supabase
      .from('bom_rows')
      .update({ status: 'pending', last_fetch_error: null })
      .eq('id', id);
    if (upErr) log('WARN clear fetch error after ok', upErr.message);
    return { ok: true, fileName: destName, bytes: fileSize };
  } catch (e) {
    try {
      await fs.unlink(tmpAbs);
    } catch {
      /* ignore */
    }
    const msg = (e instanceof Error ? e.message : String(e)).slice(0, 1000);
    log('it-download error', id, msg);
    const { error: upErr } = await supabase.from('bom_rows').update({ status: 'error', last_fetch_error: msg }).eq('id', id);
    if (upErr) log('WARN set fetch error', upErr.message);
    return { ok: false, message: msg };
  }
}


/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 */
async function failStaleDownloadJobs(supabase) {
  const staleRaw = Number(process.env.BOM_DOWNLOAD_STALE_SECONDS || 900);
  const staleSec = Number.isFinite(staleRaw) && staleRaw >= 60 ? Math.floor(staleRaw) : 900;
  const { data, error } = await supabase.rpc('bom_fail_stale_download_jobs', { p_stale_seconds: staleSec });
  if (error) {
    log('WARN bom_fail_stale_download_jobs', error.message);
    return;
  }
  const n = typeof data === 'number' ? data : Number(data);
  if (n > 0) log('bom_fail_stale_download_jobs', n);
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
  return first;
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} rootAbs
 * @param {{ id: string, row_ids: string[], progress_total: number }} job
 */
async function executeDownloadJob(supabase, rootAbs, job) {
  const jobId = job.id;
  const rowIds = Array.isArray(job.row_ids) ? job.row_ids : [];
  const total = rowIds.length;
  const heartbeatMsRaw = Number(process.env.BOM_DOWNLOAD_HEARTBEAT_MS || 15000);
  const heartbeatMs = Number.isFinite(heartbeatMsRaw) && heartbeatMsRaw >= 5000 ? Math.min(heartbeatMsRaw, 120000) : 15000;
  const progressFlushMsRaw = Number(process.env.BOM_DOWNLOAD_PROGRESS_FLUSH_MS || 10000);
  const progressFlushMs = Number.isFinite(progressFlushMsRaw) && progressFlushMsRaw >= 2000 ? Math.min(progressFlushMsRaw, 60000) : 10000;

  if (!total) {
    await patchDownloadJob(supabase, jobId, {
      status: 'failed',
      finished_at: new Date().toISOString(),
      last_message: '任务无行',
    });
    return;
  }

  const itBundle = await loadItArtifactoryDbBundle(supabase);
  if (!itDbBundleHasAnyKey(itBundle)) {
    await patchDownloadJob(supabase, jobId, {
      status: 'failed',
      finished_at: new Date().toISOString(),
      last_message:
        '未配置 it Artifactory API Key（请在数据库 system_settings.artifactory_config 配置主/扩展 Key）',
    });
    return;
  }

  const { data: targets, error: tErr } = await supabase.rpc('bom_row_download_targets', { p_ids: rowIds });
  if (tErr) {
    await patchDownloadJob(supabase, jobId, {
      status: 'failed',
      finished_at: new Date().toISOString(),
      last_message: tErr.message.slice(0, 2000),
    });
    return;
  }

  const urlMap = new Map((targets ?? []).map((t) => [t.id, t.download_url]));

  let heartbeatTimer = null;
  const touchHeartbeat = async () => {
    await patchDownloadJob(supabase, jobId, {
      heartbeat_at: new Date().toISOString(),
    });
  };
  heartbeatTimer = setInterval(() => {
    void touchHeartbeat();
  }, heartbeatMs);

  let completed = 0;
  let nOk = 0;
  let nFail = 0;
  let nSkip = 0;
  let bytesDoneTotal = 0;

  try {
    for (const rowId of rowIds) {
      const { data: still, error: e1 } = await supabase.rpc('bom_row_still_eligible_for_it_download', { p_row_id: rowId });
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
        const { error: upErr } = await supabase
          .from('bom_rows')
          .update({ status: 'error', last_fetch_error: msg.slice(0, 1000) })
          .eq('id', rowId);
        if (upErr) log('WARN set fetch error', upErr.message);
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

      const r = await downloadItArtifactRow(supabase, rootAbs, rowCreds, { id: rowId, downloadUrl: url }, {
        onProgress: ({ runningDownloaded, runningTotal, fileName }) => {
          const now = Date.now();
          if (now - lastFlush < progressFlushMs) return;
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

      if (r.ok) {
        nOk += 1;
        const b = typeof r.bytes === 'number' ? r.bytes : 0;
        bytesDoneTotal += b;
      } else {
        nFail += 1;
      }
      completed += 1;
      const tail = r.ok ? `→ ${r.fileName}` : r.message ?? '失败';
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

    let finalStatus = 'succeeded';
    let summary = `完成：成功 ${nOk}，失败 ${nFail}，跳过 ${nSkip}`;
    if (nOk === 0 && nFail > 0) {
      finalStatus = 'failed';
    } else if (nOk > 0 && nFail > 0) {
      summary = `部分失败：成功 ${nOk}，失败 ${nFail}，跳过 ${nSkip}`;
    }

    await patchDownloadJob(supabase, jobId, {
      status: finalStatus,
      finished_at: new Date().toISOString(),
      last_message: summary.slice(0, 2000),
      running_row_id: null,
      running_file_name: null,
      running_bytes_downloaded: 0,
      running_bytes_total: null,
    });
    log('web-download-job done', jobId, summary);
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
  }
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} rootAbs
 */
async function drainWebDownloadJobs(supabase, rootAbs) {
  for (;;) {
    const job = await claimDownloadJob(supabase);
    if (!job) break;
    try {
      await executeDownloadJob(supabase, rootAbs, job);
    } catch (e) {
      const msg = (e instanceof Error ? e.message : String(e)).slice(0, 2000);
      log('ERROR executeDownloadJob', job.id, msg);
      await patchDownloadJob(supabase, job.id, {
        status: 'failed',
        finished_at: new Date().toISOString(),
        last_message: msg,
        running_row_id: null,
        running_file_name: null,
      });
    }
  }
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} rootAbs
 * @param {number} intervalMs
 */
async function sleepWithDownloadPoll(supabase, rootAbs, intervalMs) {
  const tickRaw = Number(process.env.BOM_WORKER_IDLE_TICK_MS || 3000);
  const tickMs = Number.isFinite(tickRaw) && tickRaw >= 500 ? Math.min(tickRaw, 10000) : 3000;
  let remaining = intervalMs;
  while (remaining > 0) {
    try {
      await failStaleDownloadJobs(supabase);
      await drainWebDownloadJobs(supabase, rootAbs);
    } catch (e) {
      log('WARN idle download poll', e instanceof Error ? e.message : e);
    }
    const nap = Math.min(tickMs, remaining);
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
    note: 'interval from system_settings.bom_scanner.scanIntervalSeconds; it downloads only via bom_download_jobs queue',
  });

  await logItArtifactoryDbAtStartup(supabase);

  while (true) {
    let intervalSec = 30;
    try {
      intervalSec = await fetchScanIntervalSeconds(supabase);

      await failStaleDownloadJobs(supabase);
      await drainWebDownloadJobs(supabase, rootAbs);

      let jobId = await pickQueuedJob(supabase);
      while (jobId) {
        try {
          await runScanJob(supabase, jobId, rootAbs);
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
    await sleepWithDownloadPoll(supabase, rootAbs, intervalSec * 1000);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

