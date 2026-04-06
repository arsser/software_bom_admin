/** DB 不可达等可重试错误时主循环休眠（毫秒） */
export const WORKER_DB_RETRY_MS = 15000;

/** 主循环休眠期间 drain 队列步长（毫秒） */
export const IDLE_POLL_MS = 3000;

/** 下载 / ext 同步任务心跳超时判僵死（秒） */
export const JOB_STALE_SECONDS = 900;

/** 扫描任务心跳超时判僵死（秒） */
export const SCAN_STALE_SECONDS = 7200;

/** @typedef {{
 *  heartbeatMs: number,
 *  httpTimeoutMs: number,
 *  httpRetries: number,
 * }} WorkerTuning */

/** @type {WorkerTuning} */
export const defaultWorkerTuning = {
  heartbeatMs: 15000,
  httpTimeoutMs: 3600000,
  httpRetries: 2,
};

/**
 * @param {unknown} raw
 * @returns {WorkerTuning}
 */
export function resolveWorkerTuning(raw) {
  const o = raw && typeof raw === 'object' ? /** @type {Record<string, unknown>} */ (raw) : {};
  const num = (k, def, min, max) => {
    const v = o[k];
    let x = typeof v === 'number' && Number.isFinite(v) ? v : def;
    if (x < min) x = min;
    if (max != null && x > max) x = max;
    return Math.round(x);
  };
  return {
    heartbeatMs: num('heartbeatMs', defaultWorkerTuning.heartbeatMs, 5000, 120000),
    httpTimeoutMs: Math.max(1000, num('httpTimeoutMs', defaultWorkerTuning.httpTimeoutMs, 1000)),
    httpRetries: num('httpRetries', defaultWorkerTuning.httpRetries, 0, 10),
  };
}

/** @param {number} sec */
function clampScanSeconds(sec) {
  if (!Number.isFinite(sec)) return 30;
  return Math.min(86400, Math.max(5, Math.round(sec)));
}

/**
 * 单次读取 system_settings.bom_scanner：扫描间隔 + workerTuning
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 */
export async function fetchBomScannerWorkerConfig(supabase) {
  const { data, error } = await supabase.from('system_settings').select('value').eq('key', 'bom_scanner').maybeSingle();
  if (error) throw error;
  const v = data?.value && typeof data.value === 'object' ? /** @type {Record<string, unknown>} */ (data.value) : {};
  let intervalSec = 30;
  if (typeof v.scanIntervalSeconds === 'number' && Number.isFinite(v.scanIntervalSeconds)) {
    intervalSec = clampScanSeconds(v.scanIntervalSeconds);
  } else if (typeof v.scanIntervalMinutes === 'number' && Number.isFinite(v.scanIntervalMinutes)) {
    intervalSec = clampScanSeconds(v.scanIntervalMinutes * 60);
  }
  return {
    intervalSec,
    tuning: resolveWorkerTuning(v.workerTuning),
  };
}

/**
 * 读取 settings 失败时是否应短间隔重试（网络 / 连接类）
 * @param {unknown} e
 */
export function isRetriableSettingsFetchError(e) {
  if (!e || typeof e !== 'object') return false;
  const err = /** @type {Error & { code?: string; cause?: unknown }} */ (e);
  const msg = String(err.message || '').toLowerCase();
  const code = String(err.code || '').toLowerCase();
  if (code === 'econnrefused' || code === 'enotfound' || code === 'etimedout') return true;
  if (msg.includes('fetch failed') || msg.includes('network') || msg.includes('econnrefused')) return true;
  const c = err.cause;
  if (c && typeof c === 'object' && 'code' in c) {
    const cc = String(/** @type {{ code?: string }} */ (c).code || '').toLowerCase();
    if (cc === 'econnrefused' || cc === 'enotfound' || cc === 'etimedout') return true;
  }
  return false;
}
