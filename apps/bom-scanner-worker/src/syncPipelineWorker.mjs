/**
 * 一键同步编排：网页只入队 bom_sync_pipeline_jobs，本模块在 worker 内串起
 * 补全 MD5 → 本地拉取 → 校验 → ext → 飞书扫描/上传/清单，并发送飞书进度通知。
 */
import {
  fetchBatchProductDistributionSettings,
  fetchBomScannerValue,
  firstNonEmptyByKeysRelaxed,
  mergeKeyMap,
} from './extArtifactorySync.mjs';
import { reportBomLocalRootRuntime } from './workerRuntimeReport.mjs';
import { sendFeishuNotifyText } from './feishuNotify.mjs';

function log(...args) {
  console.log(new Date().toISOString(), '[sync-pipeline]', ...args);
}

const POLL_MS = 2000;
const VERIFY_TIMEOUT_MS = 10 * 60 * 1000;
const VERIFY_FAIL_GRACE_MS = 15_000;
const PROGRESS_NOTIFY_RATIO = 0.01;
const PROGRESS_NOTIFY_FALLBACK_MS = 60_000;
/** 子任务仍 running 时，距上次进度通知超过该间隔再发一条，避免长传被当成中断 */
const PROGRESS_NOTIFY_INTERVAL_MS = 10 * 60 * 1000;
const MD5_PREFIX = '[补全·MD5]';
const HEARTBEAT_MS = 2000;
const STORAGE_TIMEOUT_MS = 15_000;
const ENRICH_CONCURRENCY = 5;

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);

class PipelineCancelledError extends Error {
  constructor(message = '用户取消') {
    super(message);
    this.name = 'PipelineCancelledError';
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function formatBytesHuman(n) {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n === 0) return '0 B';
  if (n < 1024) return `${Math.round(n)} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let v = n;
  let i = -1;
  do {
    v /= 1024;
    i += 1;
  } while (v >= 1024 && i < units.length - 1);
  const digits = v >= 100 || i < 0 ? 0 : v >= 10 ? 1 : 2;
  return `${v.toFixed(digits)} ${units[i]}`;
}

function formatSpeedLabel(bytesPerSec) {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return '—';
  return `${formatBytesHuman(bytesPerSec)}/s`;
}

function formatEtaSec(sec) {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return '—';
  if (sec < 60) return `${Math.round(sec)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  if (m < 60) return s > 0 ? `${m}m${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm > 0 ? `${h}h${rm}m` : `${h}h`;
}

function stepPrefix(stepIndex, stepTotal) {
  if (
    stepIndex == null ||
    stepTotal == null ||
    !Number.isFinite(stepIndex) ||
    !Number.isFinite(stepTotal) ||
    stepIndex < 1 ||
    stepTotal < 1
  ) {
    return '';
  }
  return `${Math.floor(stepIndex)}/${Math.floor(stepTotal)} `;
}

function buildProgressText(opts) {
  const step = stepPrefix(opts.stepIndex, opts.stepTotal);
  const lines = [`【BOM】${step}${opts.title}`];
  if (opts.batchName?.trim()) lines.push(`版本：${opts.batchName.trim()}`);
  if (opts.jobId) lines.push(`任务：${String(opts.jobId).trim()}`);
  if (opts.progressPct != null && Number.isFinite(opts.progressPct)) {
    lines.push(`进度：${opts.progressPct.toFixed(1)}%`);
  }
  if (opts.progressTotal != null && opts.progressTotal > 0) {
    lines.push(`行数：${opts.progressCurrent ?? 0}/${opts.progressTotal}`);
  }
  if (opts.bytesTotal != null && opts.bytesTotal > 0) {
    const done = opts.bytesDone != null ? formatBytesHuman(opts.bytesDone) : '—';
    lines.push(`大小：${done} / ${formatBytesHuman(opts.bytesTotal)}`);
  }
  if (opts.speedBps != null && opts.speedBps > 0) {
    lines.push(`速度：${formatSpeedLabel(opts.speedBps)}`);
  }
  if (opts.etaSec != null) {
    lines.push(`ETA：${formatEtaSec(opts.etaSec)}`);
  }
  if (opts.extra?.trim()) lines.push(opts.extra.trim());
  return lines.join('\n');
}

function buildEndText(opts) {
  const step = stepPrefix(opts.stepIndex, opts.stepTotal);
  const lines = [`【BOM】${step}${opts.title} · ${opts.ok ? '成功' : '失败'}`];
  if (opts.batchName?.trim()) lines.push(`版本：${opts.batchName.trim()}`);
  if (opts.jobId) lines.push(`任务：${String(opts.jobId).trim()}`);
  if (opts.elapsedSec != null && Number.isFinite(opts.elapsedSec) && opts.elapsedSec >= 0) {
    lines.push(`耗时：${formatEtaSec(opts.elapsedSec)}`);
  }
  if (opts.bytesTotal != null && opts.bytesTotal > 0) {
    lines.push(`总大小：${formatBytesHuman(opts.bytesTotal)}`);
  }
  if (opts.avgSpeedBps != null && opts.avgSpeedBps > 0) {
    lines.push(`平均速度：${formatSpeedLabel(opts.avgSpeedBps)}`);
  }
  if (opts.detail?.trim()) lines.push(opts.detail.trim());
  return lines.join('\n');
}

function buildSkipText(opts) {
  const step = stepPrefix(opts.stepIndex, opts.stepTotal);
  const lines = [`【BOM】${step}${opts.title} · 跳过`];
  if (opts.batchName?.trim()) lines.push(`版本：${opts.batchName.trim()}`);
  if (opts.detail?.trim()) lines.push(opts.detail.trim());
  return lines.join('\n');
}

function buildDoneText(opts) {
  const step = stepPrefix(opts.stepIndex, opts.stepTotal);
  const stages = ['本地'];
  if (opts.doExt) stages.push('Artifactory-ext');
  if (opts.doFeishu) stages.push('飞书');
  const lines = [
    `【BOM】${step}同步流水线完成`,
    `版本：${opts.batchName}`,
    `行数：${opts.rowCount}`,
    `阶段：${stages.join(' → ')}`,
  ];
  if (opts.versionSheetUrl?.trim()) {
    lines.push(`软件包清单：${opts.versionSheetUrl.trim()}`);
  }
  return lines.join('\n');
}

function extractHttpUrl(raw) {
  const t = String(raw ?? '').trim();
  if (!t) return null;
  const looseMd = t.match(/\[([^\]]*)\]\(([^)]+)\)/);
  if (looseMd?.[2]) {
    const u = looseMd[2].trim();
    if (/^https?:\/\//i.test(u)) return u;
  }
  if (/^https?:\/\//i.test(t)) return t;
  return null;
}

function extractMd5(bomRow, keyMap) {
  const v = firstNonEmptyByKeysRelaxed(bomRow, keyMap.expectedMd5);
  if (!v) return null;
  const lower = String(v).trim().toLowerCase();
  return /^[a-f0-9]{32}$/.test(lower) ? lower : null;
}

function setRowFieldByAliases(row, aliases, value) {
  const next = { ...row };
  const list = (aliases || []).filter((k) => typeof k === 'string' && k.trim());
  if (!list.length) return next;
  const hit = list.find((k) => Object.prototype.hasOwnProperty.call(next, k));
  const key = hit ?? list[0];
  if (key) next[key] = value;
  return next;
}

function feishuScanErrorBlocksUpload(error) {
  const t = String(error ?? '').trim();
  if (!t) return false;
  return t.includes('本地索引中无该 MD5') || t.includes('BOM 行缺少合法期望 MD5');
}

function fileSizeAliases(scannerVal, keyMap) {
  const jm = scannerVal?.jsonKeyMap && typeof scannerVal.jsonKeyMap === 'object' ? scannerVal.jsonKeyMap : {};
  if (Array.isArray(jm.fileSizeBytes) && jm.fileSizeBytes.length) {
    return jm.fileSizeBytes.filter((x) => typeof x === 'string' && x.trim());
  }
  return ['文件大小', 'size_bytes', '远端大小'];
}

function encodePathSegment(seg) {
  const t = String(seg ?? '').trim();
  if (!t) return '';
  try {
    return encodeURIComponent(decodeURIComponent(t));
  } catch {
    return encodeURIComponent(t);
  }
}

function parseUiDownloadUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (!u.pathname.includes('/ui/api/v1/download')) return null;
    const repoKey = (u.searchParams.get('repoKey') || '').trim();
    let path = u.searchParams.get('path') || '';
    try {
      path = decodeURIComponent(path);
    } catch {
      /* keep */
    }
    try {
      path = decodeURIComponent(path);
    } catch {
      /* keep */
    }
    path = path.replace(/^\/+/, '');
    if (!repoKey || !path) return null;
    return { origin: u.origin, repoKey, path };
  } catch {
    return null;
  }
}

function toStorageApiUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (u.pathname.includes('/api/storage/')) return rawUrl;
    const ui = parseUiDownloadUrl(rawUrl);
    if (ui) {
      const pathEnc = ui.path.split('/').filter(Boolean).map(encodePathSegment).join('/');
      return `${ui.origin}/artifactory/api/storage/${encodePathSegment(ui.repoKey)}/${pathEnc}`;
    }
    const artifactoryPrefix = '/artifactory/';
    const pathIdx = u.pathname.indexOf(artifactoryPrefix);
    if (pathIdx === -1) {
      const path = u.pathname.startsWith('/') ? u.pathname : `/${u.pathname}`;
      return `${u.origin}/artifactory/api/storage${path}`;
    }
    const pathAfterPrefix = u.pathname.substring(pathIdx + artifactoryPrefix.length);
    return `${u.origin}${artifactoryPrefix}api/storage/${pathAfterPrefix}`;
  } catch {
    return null;
  }
}

function normalizeBaseUrl(url) {
  if (!url || typeof url !== 'string') return '';
  return url.trim().replace(/\/+$/, '');
}

function jfrogHeaders(apiKey) {
  const headers = {
    'User-Agent': 'software-bom-admin-worker/1.0',
    Accept: '*/*',
  };
  if (apiKey) {
    headers['X-JFrog-Art-Api'] = apiKey;
    headers['X-Api-Key'] = apiKey;
  }
  return headers;
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 */
async function loadArtifactoryConfig(supabase) {
  const { data, error } = await supabase
    .from('system_settings')
    .select('value')
    .eq('key', 'artifactory_config')
    .maybeSingle();
  if (error) throw new Error(`读取 artifactory_config 失败：${error.message}`);
  const v = data?.value ?? {};
  return {
    artifactoryBaseUrl: normalizeBaseUrl(v.artifactoryBaseUrl),
    artifactoryApiKey: typeof v.artifactoryApiKey === 'string' ? v.artifactoryApiKey.trim() : '',
    artifactoryExtBaseUrl: normalizeBaseUrl(v.artifactoryExtBaseUrl),
    artifactoryExtApiKey: typeof v.artifactoryExtApiKey === 'string' ? v.artifactoryExtApiKey.trim() : '',
  };
}

function pickHeadersByUrl(cleanUrl, cfg) {
  const primaryBase = cfg.artifactoryBaseUrl;
  const extBase = cfg.artifactoryExtBaseUrl;
  if (primaryBase && cleanUrl.startsWith(primaryBase)) return jfrogHeaders(cfg.artifactoryApiKey);
  if (extBase && cleanUrl.startsWith(extBase)) return jfrogHeaders(cfg.artifactoryExtApiKey);
  if (!primaryBase && !extBase) return jfrogHeaders(cfg.artifactoryApiKey || cfg.artifactoryExtApiKey);
  return jfrogHeaders('');
}

async function fetchStorageApiInfo(url, headers) {
  const apiUrl = toStorageApiUrl(url);
  if (!apiUrl) return { url, ok: false, error: 'Invalid Artifactory URL' };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), STORAGE_TIMEOUT_MS);
  try {
    const res = await fetch(apiUrl, { method: 'GET', headers, signal: controller.signal });
    const text = await res.text();
    if (!res.ok) {
      return { url, ok: false, status: res.status, error: `HTTP ${res.status} ${text.slice(0, 180)}` };
    }
    let info;
    try {
      info = JSON.parse(text);
    } catch {
      return { url, ok: false, error: 'Storage API 非 JSON' };
    }
    return { url, ok: true, status: res.status, info };
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    return { url, ok: false, error: err.name === 'AbortError' ? 'Request timed out' : err.message };
  } finally {
    clearTimeout(timeout);
  }
}

function numField(v, fallback = 0) {
  if (v == null) return fallback;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function numOrNull(v) {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function effectiveTransferred(job, runningAlreadyInTotal) {
  const done = Math.max(0, numField(job.bytes_downloaded_total));
  if (job.status === 'running' && !runningAlreadyInTotal) {
    return done + Math.max(0, numField(job.running_bytes_downloaded));
  }
  return done;
}

function elapsedSecSince(startedAt, finishedAt) {
  if (!startedAt) return null;
  const start = Date.parse(startedAt);
  if (!Number.isFinite(start)) return null;
  const end = finishedAt ? Date.parse(finishedAt) : Date.now();
  if (!Number.isFinite(end) || end < start) return null;
  return (end - start) / 1000;
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} id
 * @param {Record<string, unknown>} patch
 */
async function patchPipeline(supabase, id, patch) {
  const { error } = await supabase
    .from('bom_sync_pipeline_jobs')
    .update({ ...patch, heartbeat_at: new Date().toISOString() })
    .eq('id', id);
  if (error) log('WARN patch pipeline', id, error.message);
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} id
 */
async function loadPipeline(supabase, id) {
  const { data, error } = await supabase.from('bom_sync_pipeline_jobs').select('*').eq('id', id).maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} batchId
 * @param {string[] | null} scopeIds
 */
async function loadScopeRows(supabase, batchId, scopeIds) {
  const { data, error } = await supabase
    .from('bom_rows')
    .select('id,bom_row,status')
    .eq('batch_id', batchId)
    .order('created_at', { ascending: true });
  if (error) throw new Error(error.message);
  const all = data ?? [];
  if (!scopeIds || scopeIds.length === 0) return all;
  const wanted = new Set(scopeIds);
  const scope = all.filter((r) => wanted.has(r.id));
  if (scope.length !== wanted.size) {
    throw new Error(`作用域行数异常：期望 ${wanted.size}，实际 ${scope.length}`);
  }
  return scope;
}

function localOf(row) {
  return row?.status && typeof row.status === 'object' ? String(row.status.local ?? '') : '';
}

function feishuOf(row) {
  return row?.status && typeof row.status === 'object' ? String(row.status.feishu ?? 'not_scanned') : 'not_scanned';
}

function extUrlOf(row, keyMap) {
  return firstNonEmptyByKeysRelaxed(row.bom_row, keyMap.extUrl) || '';
}

function componentOf(row, keyMap) {
  return firstNonEmptyByKeysRelaxed(row.bom_row, keyMap.component) || String(row.id).slice(0, 8);
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} pStaleSeconds
 */
export async function failStaleSyncPipelineJobs(supabase, staleSec) {
  const sec = Number(staleSec) > 60 ? Number(staleSec) : 900;
  const { data, error } = await supabase.rpc('bom_fail_stale_sync_pipeline_jobs', { p_stale_seconds: sec });
  if (error) {
    log('WARN failStaleSyncPipelineJobs', error.message);
    return;
  }
  const n = typeof data === 'number' ? data : 0;
  if (n > 0) log('stale pipeline jobs failed', n);
  if (n <= 0) return;
  const cutoff = new Date(Date.now() - 120_000).toISOString();
  const { data: rows, error: qErr } = await supabase
    .from('bom_sync_pipeline_jobs')
    .select('id,batch_id,last_message')
    .eq('status', 'failed')
    .gte('finished_at', cutoff)
    .ilike('last_message', '%心跳超时%');
  if (qErr) {
    log('WARN list stale pipelines', qErr.message);
    return;
  }
  for (const row of rows ?? []) {
    let batchName = String(row.batch_id ?? '');
    const { data: b } = await supabase.from('bom_batches').select('name').eq('id', row.batch_id).maybeSingle();
    if (b?.name) batchName = String(b.name);
    await sendFeishuNotifyText(
      supabase,
      `【BOM】同步流水线失败\n版本：${batchName}\n${String(row.last_message ?? 'worker 心跳超时')}`.slice(0, 1800),
    );
  }
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} rootAbs
 * @param {import('./workerTuning.mjs').WorkerTuning} tuning
 * @param {{ drainChildren: () => Promise<void> }} hooks
 */
export async function drainSyncPipelineJobs(supabase, rootAbs, tuning, hooks) {
  for (;;) {
    const { data, error } = await supabase.rpc('bom_claim_sync_pipeline_job');
    if (error) {
      log('WARN bom_claim_sync_pipeline_job', error.message);
      break;
    }
    const rows = Array.isArray(data) ? data : data ? [data] : [];
    const first = rows[0];
    if (!first?.id) break;
    try {
      await executeSyncPipelineJob(supabase, rootAbs, first, hooks);
    } catch (e) {
      const msg = (e instanceof Error ? e.message : String(e)).slice(0, 2000);
      log('ERROR executeSyncPipelineJob', first.id, msg);
      await patchPipeline(supabase, first.id, {
        status: 'failed',
        phase: 'failed',
        finished_at: new Date().toISOString(),
        last_message: msg,
        current_child_job_id: null,
        current_child_kind: null,
      });
    }
  }
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} rootAbs
 * @param {{ id: string, batch_id: string, user_id: string, row_ids: string[] | null, do_ext: boolean, do_feishu: boolean, enrich_md5: boolean }} claimed
 * @param {{ drainChildren: () => Promise<void> }} hooks
 */
async function executeSyncPipelineJob(supabase, rootAbs, claimed, hooks) {
  const jobId = String(claimed.id);
  const batchId = String(claimed.batch_id);
  const userId = String(claimed.user_id);
  const doExt = Boolean(claimed.do_ext);
  const doFeishu = Boolean(claimed.do_feishu);
  const enrichMd5 = claimed.enrich_md5 !== false;
  const scopeIds =
    Array.isArray(claimed.row_ids) && claimed.row_ids.length > 0 ? claimed.row_ids.map((x) => String(x)) : null;

  const dist = await fetchBatchProductDistributionSettings(supabase, batchId);
  const batchName = dist.batchName || batchId;
  if (doExt && !dist.extArtifactoryRepo) {
    throw new Error('已勾选 Artifactory-ext：请先在产品中配置外部仓库');
  }
  if (doFeishu && !dist.feishuDriveRootFolderToken) {
    throw new Error('已勾选飞书：请先在产品中配置飞书根目录');
  }

  const scannerVal = await fetchBomScannerValue(supabase);
  const keyMap = mergeKeyMap(scannerVal);
  const sizeAliases = fileSizeAliases(scannerVal, keyMap);

  const phases = [
    ...(enrichMd5 ? ['enrich_md5'] : []),
    'download',
    'wait_verified',
    ...(doExt ? ['ext_sync'] : []),
    ...(doFeishu ? ['feishu_scan', 'feishu_upload', 'version_sheet'] : []),
    'done',
  ];
  const stepFor = (phase) => ({
    stepIndex: phases.indexOf(phase) + 1,
    stepTotal: phases.length,
  });

  const notify = (text) => sendFeishuNotifyText(supabase, text);
  const skip = (phase, title, detail) =>
    notify(buildSkipText({ title, batchName, detail, ...stepFor(phase) }));

  const ctx = {
    progressNotified: false,
    lastProgressNotifiedAt: 0,
    endNotified: false,
    watchStarted: Date.now(),
    childKind: null,
    childTable: null,
    runningAlreadyInTotal: false,
    simpleProgress: false,
    step: { stepIndex: null, stepTotal: null },
    label: '',
    sample: null,
  };

  let hbBusy = false;
  const hbTimer = setInterval(() => {
    if (hbBusy) return;
    hbBusy = true;
    void (async () => {
      try {
        await supabase
          .from('bom_sync_pipeline_jobs')
          .update({ heartbeat_at: new Date().toISOString() })
          .eq('id', jobId);
        await maybeNotifyChildProgress(supabase, jobId, batchName, ctx);
      } catch (e) {
        log('WARN pipeline heartbeat', jobId, e instanceof Error ? e.message : e);
      } finally {
        hbBusy = false;
      }
    })();
  }, HEARTBEAT_MS);

  await reportBomLocalRootRuntime(supabase, rootAbs, { phase: 'busy', busyHint: 'sync-pipeline' });

  let versionSheetUrl = null;
  try {
    await throwIfCancelled(supabase, jobId);

    let scope = await loadScopeRows(supabase, batchId, scopeIds);
    if (scope.length === 0) throw new Error('当前版本没有数据行');

    if (enrichMd5) {
      await setPhase(supabase, jobId, 'enrich_md5', `补全 MD5（${scope.length} 行）…`);
      const missingBefore = scope.filter((row) => !extractMd5(row.bom_row, keyMap));
      if (missingBefore.length === 0) {
        await skip('enrich_md5', '补全 MD5', `作用域内 ${scope.length} 行均已有 MD5`);
      } else {
        const summary = await enrichMd5ForRows(supabase, missingBefore, keyMap, sizeAliases, () =>
          throwIfCancelled(supabase, jobId),
        );
        if (sizeAliases[0]) {
          await ensureHeaderKeys(supabase, batchId, [sizeAliases[0]]);
        }
        scope = await loadScopeRows(supabase, batchId, scopeIds);
        const missingMd5 = scope.filter((row) => !extractMd5(row.bom_row, keyMap));
        if (missingMd5.length > 0) {
          const samples = missingMd5.slice(0, 5).map((row) => {
            const component = componentOf(row, keyMap);
            const raw = firstNonEmptyByKeysRelaxed(row.bom_row, keyMap.downloadUrl);
            const url = raw ? extractHttpUrl(raw) : null;
            const reason =
              String(row.status?.it_fetch_error ?? '').trim() ||
              (!raw ? '缺少下载地址' : !url ? '下载地址不是有效 HTTP(S) URL' : 'API 未返回 MD5');
            return `${component}：${reason}`;
          });
          const tip =
            summary.failedChunks > 0
              ? `；请求批次失败 ${summary.failedChunks} 次`
              : summary.apiRespondedErrorCount > 0
                ? `；Storage API 失败 ${summary.apiRespondedErrorCount} 行`
                : summary.apiOkButNoMd5Count > 0
                  ? `；API 成功但无 MD5 ${summary.apiOkButNoMd5Count} 行`
                  : '';
          throw new Error(
            `作用域内有 ${missingMd5.length} 行未能补全 MD5${tip}。示例：${samples.join('；')}`,
          );
        }
        await notify(
          buildEndText({
            title: '补全 MD5',
            batchName,
            ok: true,
            detail: `已补全 ${summary.md5FilledCount} 行`,
            ...stepFor('enrich_md5'),
          }),
        );
      }
    }

    await throwIfCancelled(supabase, jobId);
    await setPhase(supabase, jobId, 'download', '检查本地是否已有文件…');
    await supabase.rpc('bom_refresh_local_found_statuses_for_batch', { p_batch_id: batchId });
    scope = await loadScopeRows(supabase, batchId, scopeIds);
    const verifiedCount = scope.filter((row) => localOf(row) === 'verified_ok').length;

    const downloadId = await enqueueChild(supabase, 'bom_worker_enqueue_download', {
      p_batch_id: batchId,
      p_user_id: userId,
      p_row_ids: scopeIds,
    });
    if (!downloadId) {
      if (verifiedCount === scope.length) {
        await skip('download', '本地拉取', `作用域内 ${scope.length} 行均已有本地文件`);
      } else {
        const sample = scope
          .filter((row) => localOf(row) !== 'verified_ok')
          .slice(0, 5)
          .map((row) => `${componentOf(row, keyMap)}(${localOf(row)})`)
          .join('；');
        throw new Error(
          `没有可拉取的行，且尚未全部校验通过（${verifiedCount}/${scope.length}）。示例：${sample || '—'}`,
        );
      }
    } else {
      await waitChildJob(supabase, hooks, {
        pipelineId: jobId,
        batchName,
        childId: downloadId,
        kind: 'download',
        table: 'bom_download_jobs',
        label: '本地拉取',
        runningAlreadyInTotal: false,
        step: stepFor('download'),
        ctx,
        phase: 'download',
        message: '正在拉取到本地…',
      });
    }

    await throwIfCancelled(supabase, jobId);
    await setPhase(supabase, jobId, 'wait_verified', '等待本地 MD5 校验通过…', {
      current_child_job_id: null,
      current_child_kind: null,
    });
    scope = await waitAllVerified(supabase, hooks, {
      pipelineId: jobId,
      batchId,
      scopeIds,
      expectedCount: scope.length,
      batchName,
      step: stepFor('wait_verified'),
    });

    if (doExt) {
      await throwIfCancelled(supabase, jobId);
      await setPhase(supabase, jobId, 'ext_sync', '检查 Artifactory-ext…');
      scope = await loadScopeRows(supabase, batchId, scopeIds);
      const extId = await enqueueChild(supabase, 'bom_worker_enqueue_ext_sync', {
        p_batch_id: batchId,
        p_user_id: userId,
        p_row_ids: scopeIds,
      });
      if (!extId) {
        const incomplete = scope.filter((row) => !String(extUrlOf(row, keyMap)).trim());
        if (incomplete.length === 0) {
          await skip('ext_sync', 'Artifactory-ext 同步', `作用域内 ${scope.length} 行均已完成`);
        } else {
          const sample = incomplete
            .slice(0, 5)
            .map((row) => `${componentOf(row, keyMap)}(local=${localOf(row)}, ext=${row.status?.ext ?? ''})`)
            .join('；');
          throw new Error(`没有可同步到 Artifactory-ext 的行，且存在未完成行。示例：${sample || '—'}`);
        }
      } else {
        await waitChildJob(supabase, hooks, {
          pipelineId: jobId,
          batchName,
          childId: extId,
          kind: 'ext_sync',
          table: 'bom_ext_sync_jobs',
          label: 'Artifactory-ext 同步',
          runningAlreadyInTotal: false,
          step: stepFor('ext_sync'),
          ctx,
          phase: 'ext_sync',
          message: '正在同步到 Artifactory-ext…',
        });
      }
    }

    if (doFeishu) {
      await throwIfCancelled(supabase, jobId);
      await setPhase(supabase, jobId, 'feishu_scan', '入队飞书扫描（自动创建版本目录）…');
      const scanId = await enqueueFeishuScan(supabase, batchId, scope.length);
      await waitChildJob(supabase, hooks, {
        pipelineId: jobId,
        batchName,
        childId: scanId,
        kind: 'feishu_scan',
        table: 'bom_feishu_scan_jobs',
        label: '飞书扫描',
        runningAlreadyInTotal: true,
        simple: true,
        step: stepFor('feishu_scan'),
        ctx,
        phase: 'feishu_scan',
        message: '正在扫描飞书目录…',
      });

      await throwIfCancelled(supabase, jobId);
      scope = await loadScopeRows(supabase, batchId, scopeIds);
      const uploadCandidates = scope.filter((row) => {
        if (localOf(row) !== 'verified_ok') return false;
        const f = feishuOf(row);
        if (f !== 'absent' && f !== 'error') return false;
        return !feishuScanErrorBlocksUpload(row.status?.feishu_scan_error);
      });
      const presentCount = scope.filter((row) => feishuOf(row) === 'present').length;
      const uploadRowIds = uploadCandidates.map((r) => r.id);

      await setPhase(supabase, jobId, 'feishu_upload', '检查飞书上传…');
      let uploadId = null;
      if (uploadRowIds.length === 0) {
        if (presentCount === scope.length) {
          await skip('feishu_upload', '飞书上传', `作用域内 ${scope.length} 行均已存在`);
        } else {
          const sample = scope
            .slice(0, 5)
            .map(
              (row) =>
                `${componentOf(row, keyMap)}(${feishuOf(row)}${row.status?.feishu_scan_error ? '/有扫描错误' : ''})`,
            )
            .join('；');
          throw new Error(
            `飞书扫描后没有可上传的行（present ${presentCount}/${scope.length}）。示例：${sample}`,
          );
        }
      } else {
        uploadId = await enqueueChild(supabase, 'bom_worker_enqueue_feishu_upload', {
          p_batch_id: batchId,
          p_user_id: userId,
          p_row_ids: uploadRowIds,
        });
        if (!uploadId) {
          throw new Error('飞书上传入队失败：没有符合条件的行');
        }
        await waitChildJob(supabase, hooks, {
          pipelineId: jobId,
          batchName,
          childId: uploadId,
          kind: 'feishu_upload',
          table: 'bom_feishu_upload_jobs',
          label: '飞书上传',
          runningAlreadyInTotal: true,
          step: stepFor('feishu_upload'),
          ctx,
          phase: 'feishu_upload',
          message: '正在上传到飞书…',
        });
      }

      await throwIfCancelled(supabase, jobId);
      await setPhase(supabase, jobId, 'version_sheet', '生成版本目录「软件包清单」…');
      const { data: sheetJobId, error: sheetErr } = await supabase.rpc('bom_enqueue_feishu_version_sheet', {
        p_batch_id: batchId,
        p_trigger_source: 'pipeline',
      });
      if (sheetErr || !sheetJobId) {
        throw new Error(sheetErr?.message || '软件包清单入队失败');
      }
      const sheet = await waitChildJob(supabase, hooks, {
        pipelineId: jobId,
        batchName,
        childId: String(sheetJobId),
        kind: 'version_sheet',
        table: 'bom_feishu_version_sheet_jobs',
        label: '生成软件包清单',
        runningAlreadyInTotal: true,
        simple: true,
        step: stepFor('version_sheet'),
        ctx,
        phase: 'version_sheet',
        message: '正在生成软件包清单…',
      });
      versionSheetUrl = typeof sheet?.sheet_url === 'string' ? sheet.sheet_url.trim() || null : null;
    }

    scope = await loadScopeRows(supabase, batchId, scopeIds);
    const doneMsg = versionSheetUrl ? `同步完成；软件包清单：${versionSheetUrl}` : '同步流水线已完成';
    await patchPipeline(supabase, jobId, {
      status: 'succeeded',
      phase: 'done',
      finished_at: new Date().toISOString(),
      last_message: doneMsg,
      current_child_job_id: null,
      current_child_kind: null,
      cancel_requested: false,
    });
    await notify(
      buildDoneText({
        batchName,
        rowCount: scope.length,
        doExt,
        doFeishu,
        versionSheetUrl,
        ...stepFor('done'),
      }),
    );
    log('pipeline done', jobId, { batchId, batchName, rows: scope.length });
  } catch (e) {
    if (e instanceof PipelineCancelledError) {
      await patchPipeline(supabase, jobId, {
        status: 'cancelled',
        phase: 'failed',
        finished_at: new Date().toISOString(),
        last_message: e.message || '用户取消',
        current_child_job_id: null,
        current_child_kind: null,
        cancel_requested: false,
      });
      await notify(`【BOM】同步流水线已取消\n版本：${batchName}`);
      log('pipeline cancelled', jobId);
      return;
    }
    const msg = (e instanceof Error ? e.message : String(e)).slice(0, 2000);
    await patchPipeline(supabase, jobId, {
      status: 'failed',
      phase: 'failed',
      finished_at: new Date().toISOString(),
      last_message: msg,
      current_child_job_id: null,
      current_child_kind: null,
    });
    await notify(`【BOM】同步流水线失败\n版本：${batchName}\n${msg}`.slice(0, 1800));
    throw e;
  } finally {
    clearInterval(hbTimer);
    await reportBomLocalRootRuntime(supabase, rootAbs, { phase: 'idle' });
  }
}

async function setPhase(supabase, jobId, phase, message, extra = {}) {
  await patchPipeline(supabase, jobId, {
    phase,
    last_message: message,
    ...extra,
  });
}

async function throwIfCancelled(supabase, jobId) {
  const row = await loadPipeline(supabase, jobId);
  if (!row) throw new Error('流水线任务不存在');
  if (row.status === 'cancelled' || row.cancel_requested) {
    throw new PipelineCancelledError(row.last_message || '用户取消');
  }
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} fn
 * @param {{ p_batch_id: string, p_user_id: string, p_row_ids: string[] | null }} args
 */
async function enqueueChild(supabase, fn, args) {
  const payload = {
    p_batch_id: args.p_batch_id,
    p_user_id: args.p_user_id,
    p_row_ids: args.p_row_ids && args.p_row_ids.length ? args.p_row_ids : null,
  };
  const { data, error } = await supabase.rpc(fn, payload);
  if (error) throw new Error(error.message);
  if (data == null || data === '') return null;
  return String(data);
}

async function enqueueFeishuScan(supabase, batchId, rowsTotal) {
  const { data, error } = await supabase
    .from('bom_feishu_scan_jobs')
    .insert({
      batch_id: batchId,
      status: 'queued',
      trigger_source: 'pipeline',
      message: null,
      rows_total: rowsTotal,
      rows_present: 0,
      rows_absent: 0,
      rows_error: 0,
      started_at: null,
      auto_create_version_folder: true,
    })
    .select('id')
    .single();
  if (error || !data?.id) throw new Error(error?.message || '无法创建飞书扫描任务');
  return String(data.id);
}

async function fetchChild(supabase, table, id) {
  const { data, error } = await supabase.from(table).select('*').eq('id', id).maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

function childMessage(job) {
  return String(job?.last_message || job?.message || '').trim();
}

async function sendChildEndNotify(supabase, batchName, ctx, job) {
  if (ctx.endNotified) return;
  ctx.endNotified = true;
  if (job.status !== 'succeeded') return;
  const elapsed = elapsedSecSince(job.started_at, job.finished_at);
  const simple = Boolean(ctx.simpleProgress);
  const transferred = simple ? null : effectiveTransferred(job, ctx.runningAlreadyInTotal);
  const avgSpeed =
    !simple && elapsed != null && elapsed > 0 && transferred > 0 ? transferred / elapsed : null;
  await sendFeishuNotifyText(
    supabase,
    buildEndText({
      title: ctx.label,
      batchName,
      jobId: job.id,
      ok: true,
      elapsedSec: elapsed,
      bytesTotal: simple ? null : numOrNull(job.bytes_total),
      avgSpeedBps: avgSpeed,
      detail: childMessage(job) || undefined,
      ...ctx.step,
    }),
  );
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {{ drainChildren: (kind?: string) => Promise<void> }} hooks
 */
async function waitChildJob(supabase, hooks, opts) {
  const {
    pipelineId,
    batchName,
    childId,
    kind,
    table,
    label,
    runningAlreadyInTotal,
    simple,
    step,
    ctx,
    phase,
    message,
  } = opts;

  ctx.progressNotified = false;
  ctx.lastProgressNotifiedAt = 0;
  ctx.endNotified = false;
  ctx.watchStarted = Date.now();
  ctx.childKind = kind;
  ctx.childTable = table;
  ctx.runningAlreadyInTotal = Boolean(runningAlreadyInTotal);
  ctx.simpleProgress = Boolean(simple);
  ctx.step = step;
  ctx.label = label;
  ctx.sample = null;

  await patchPipeline(supabase, pipelineId, {
    phase,
    last_message: message,
    current_child_job_id: childId,
    current_child_kind: kind,
  });

  for (;;) {
    await throwIfCancelled(supabase, pipelineId);
    try {
      await hooks.drainChildren(kind);
    } catch (e) {
      log('WARN drainChildren', e instanceof Error ? e.message : e);
    }
    const job = await fetchChild(supabase, table, childId);
    if (job && TERMINAL.has(String(job.status))) {
      const ok = job.status === 'succeeded';
      if (ok) {
        await sendChildEndNotify(supabase, batchName, ctx, job);
      }
      if (!ok) {
        const pipe = await loadPipeline(supabase, pipelineId);
        if (pipe?.cancel_requested || pipe?.status === 'cancelled' || job.status === 'cancelled') {
          throw new PipelineCancelledError(pipe?.last_message || '用户取消');
        }
        throw new Error(`${label}失败：${childMessage(job) || job.status}`);
      }
      return job;
    }
    await sleep(POLL_MS);
  }
}

async function maybeNotifyChildProgress(supabase, pipelineId, batchName, ctx) {
  if (!ctx.childTable || !ctx.label || ctx.endNotified) return;
  const pipe = await loadPipeline(supabase, pipelineId);
  if (!pipe?.current_child_job_id) return;
  const job = await fetchChild(supabase, ctx.childTable, pipe.current_child_job_id);
  if (!job) return;
  if (TERMINAL.has(String(job.status))) {
    await sendChildEndNotify(supabase, batchName, ctx, job);
    return;
  }
  if (job.status !== 'running') return;

  const nowMs = Date.now();
  const lastAt = Number(ctx.lastProgressNotifiedAt) || 0;
  const dueRepeat = lastAt > 0 && nowMs - lastAt >= PROGRESS_NOTIFY_INTERVAL_MS;
  const first = !ctx.progressNotified;

  if (ctx.simpleProgress) {
    if (!first && !dueRepeat) return;
    ctx.progressNotified = true;
    ctx.lastProgressNotifiedAt = nowMs;
    await sendFeishuNotifyText(
      supabase,
      buildProgressText({
        title: `${ctx.label}进行中`,
        batchName,
        jobId: job.id,
        extra: first ? '（无字节进度，任务已开始）' : '（仍在进行）',
        ...ctx.step,
      }),
    );
    return;
  }

  const transferred = effectiveTransferred(job, ctx.runningAlreadyInTotal);
  const total = numOrNull(job.bytes_total);
  const ratio = total != null && total > 0 ? transferred / total : 0;
  const rowRatio =
    numField(job.progress_total) > 0 ? numField(job.progress_current) / numField(job.progress_total) : 0;

  if (first) {
    const hitPct = ratio >= PROGRESS_NOTIFY_RATIO || rowRatio >= PROGRESS_NOTIFY_RATIO;
    const fallback =
      !hitPct &&
      nowMs - ctx.watchStarted >= PROGRESS_NOTIFY_FALLBACK_MS &&
      (transferred > 0 || numField(job.progress_current) > 0 || (total != null && total > 0));
    if (!hitPct && !fallback) return;
  } else if (!dueRepeat) {
    return;
  }

  let speedBps = null;
  let etaSec = null;
  const startedMs = job.started_at ? Date.parse(job.started_at) : NaN;
  if (Number.isFinite(startedMs) && nowMs > startedMs) {
    const elapsed = (nowMs - startedMs) / 1000;
    if (elapsed >= 1.5 && transferred > 0) {
      speedBps = transferred / elapsed;
      if (total != null && total > transferred && speedBps > 0) {
        etaSec = (total - transferred) / speedBps;
      }
    }
  }
  const pct = total != null && total > 0 ? Math.min(100, (transferred / total) * 100) : rowRatio * 100;
  ctx.progressNotified = true;
  ctx.lastProgressNotifiedAt = nowMs;
  const extra = first
    ? nowMs - ctx.watchStarted >= PROGRESS_NOTIFY_FALLBACK_MS &&
      ratio < PROGRESS_NOTIFY_RATIO &&
      rowRatio < PROGRESS_NOTIFY_RATIO
      ? '（进度不足 1%，超时兜底通知）'
      : undefined
    : '（仍在进行）';
  await sendFeishuNotifyText(
    supabase,
    buildProgressText({
      title: `${ctx.label}进行中`,
      batchName,
      jobId: job.id,
      progressPct: pct,
      bytesTotal: total,
      bytesDone: transferred,
      speedBps,
      etaSec,
      progressCurrent: numField(job.progress_current),
      progressTotal: numField(job.progress_total) || null,
      extra,
      ...ctx.step,
    }),
  );
}

async function waitAllVerified(supabase, hooks, opts) {
  const { pipelineId, batchId, scopeIds, expectedCount, batchName, step } = opts;
  let scope = await loadScopeRows(supabase, batchId, scopeIds);
  if (scope.length !== expectedCount) {
    throw new Error(`作用域行数异常：期望 ${expectedCount}，实际 ${scope.length}`);
  }
  if (scope.every((row) => localOf(row) === 'verified_ok')) {
    await sendFeishuNotifyText(
      supabase,
      buildSkipText({
        title: '本地校验',
        batchName,
        detail: `作用域内 ${expectedCount} 行已全部校验通过`,
        ...step,
      }),
    );
    return scope;
  }

  const started = Date.now();
  for (;;) {
    await throwIfCancelled(supabase, pipelineId);
    try {
      await hooks.drainChildren('download');
    } catch (e) {
      log('WARN drainChildren verify', e instanceof Error ? e.message : e);
    }
    await supabase.rpc('bom_refresh_local_found_statuses_for_batch', { p_batch_id: batchId });
    scope = await loadScopeRows(supabase, batchId, scopeIds);
    if (scope.length !== expectedCount) {
      throw new Error(`作用域行数异常：期望 ${expectedCount}，实际 ${scope.length}`);
    }
    if (scope.every((row) => localOf(row) === 'verified_ok')) {
      await sendFeishuNotifyText(
        supabase,
        buildEndText({
          title: '本地校验',
          batchName,
          ok: true,
          elapsedSec: (Date.now() - started) / 1000,
          detail: `${scope.length} 行全部通过`,
          ...step,
        }),
      );
      return scope;
    }
    const failed = scope.filter((row) => {
      const loc = localOf(row);
      return loc === 'verified_fail' || loc === 'error';
    });
    if (failed.length > 0 && Date.now() - started > VERIFY_FAIL_GRACE_MS) {
      const detail = failed
        .slice(0, 5)
        .map((row) => row.status?.local_fetch_error || localOf(row))
        .join('；');
      throw new Error(`本地校验未通过（${failed.length}/${scope.length}）：${detail}`);
    }
    if (Date.now() - started > VERIFY_TIMEOUT_MS) {
      const pending = scope.filter((row) => localOf(row) !== 'verified_ok').length;
      throw new Error(`等待本地校验超时：仍有 ${pending} 行未通过`);
    }
    await sleep(POLL_MS);
  }
}

async function ensureHeaderKeys(supabase, batchId, keys) {
  const { data, error } = await supabase.from('bom_batches').select('header_order').eq('id', batchId).maybeSingle();
  if (error) {
    log('WARN read header_order', error.message);
    return;
  }
  const existing = Array.isArray(data?.header_order) ? data.header_order.map((x) => String(x)) : [];
  const seen = new Set(existing.map((h) => h.trim()));
  const out = [...existing];
  for (const k of keys) {
    const t = String(k ?? '').trim();
    if (!t || seen.has(t)) continue;
    out.push(t);
    seen.add(t);
  }
  if (out.length === existing.length) return;
  const { error: upErr } = await supabase
    .from('bom_batches')
    .update({ header_order: out.slice(0, 64) })
    .eq('id', batchId);
  if (upErr) log('WARN update header_order', upErr.message);
}

async function enrichMd5ForRows(supabase, rows, keyMap, sizeAliases, onChunk) {
  const cfg = await loadArtifactoryConfig(supabase);
  if (!cfg.artifactoryApiKey && !cfg.artifactoryExtApiKey) {
    throw new Error('无法读取 Artifactory 配置，请检查系统设置');
  }
  const summary = {
    failedChunks: 0,
    md5FilledCount: 0,
    apiRespondedErrorCount: 0,
    apiOkButNoMd5Count: 0,
  };

  const indexed = [];
  for (const row of rows) {
    const raw = firstNonEmptyByKeysRelaxed(row.bom_row, keyMap.downloadUrl);
    const url = raw ? extractHttpUrl(raw) : null;
    if (!url) continue;
    indexed.push({ row, url });
  }

  const runOne = async (item) => {
    const headers = pickHeadersByUrl(item.url, cfg);
    return fetchStorageApiInfo(item.url, headers);
  };

  for (let i = 0; i < indexed.length; i += ENRICH_CONCURRENCY) {
    if (typeof onChunk === 'function') await onChunk();
    const slice = indexed.slice(i, i + ENRICH_CONCURRENCY);
    const results = await Promise.all(slice.map((item) => runOne(item)));
    for (let j = 0; j < slice.length; j += 1) {
      const item = slice[j];
      const res = results[j];
      const beforeMd5 = extractMd5(item.row.bom_row, keyMap);
      let nextBom = { ...(item.row.bom_row || {}) };
      let itErr = item.row.status?.it_fetch_error ?? null;
      if (res.ok && res.info) {
        const md5 = res.info.checksums?.md5 ?? res.info.originalChecksums?.md5;
        if (md5 && /^[a-fA-F0-9]{32}$/.test(String(md5).trim())) {
          nextBom = setRowFieldByAliases(nextBom, keyMap.expectedMd5, String(md5).trim().toLowerCase());
        }
        if (typeof res.info.size === 'number' && Number.isFinite(res.info.size) && res.info.size >= 0) {
          nextBom = setRowFieldByAliases(nextBom, sizeAliases, String(Math.round(res.info.size)));
        }
        const prev = String(itErr ?? '').trim();
        if (prev.startsWith(MD5_PREFIX) || prev.startsWith('[Artifactory]')) itErr = null;
        const afterMd5 = extractMd5(nextBom, keyMap);
        if (!beforeMd5 && afterMd5) summary.md5FilledCount += 1;
        else if (!afterMd5) summary.apiOkButNoMd5Count += 1;
      } else {
        summary.apiRespondedErrorCount += 1;
        const err = res.error ?? `HTTP ${res.status ?? '错误'}`;
        const short = err.length > 200 ? `${err.slice(0, 197)}…` : err;
        itErr = `${MD5_PREFIX} ${short}`.slice(0, 1000);
      }
      const st = { ...(item.row.status && typeof item.row.status === 'object' ? item.row.status : {}) };
      if (itErr) st.it_fetch_error = itErr;
      else delete st.it_fetch_error;
      const { error: upErr } = await supabase
        .from('bom_rows')
        .update({ bom_row: nextBom, status: st })
        .eq('id', item.row.id);
      if (upErr) throw new Error(`写回 MD5 失败：${upErr.message}`);
    }
  }
  return summary;
}
