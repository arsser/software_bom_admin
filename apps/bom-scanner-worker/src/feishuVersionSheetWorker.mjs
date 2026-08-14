/**
 * 版本目录「软件包清单」电子表格任务（上传成功后自动入队；亦可手动重生成）。
 */

import { generateVersionPackageSheetForBatch } from './feishuVersionSheet.mjs';
import { reportBomLocalRootRuntime } from './workerRuntimeReport.mjs';
import { notifyFeishuJobFailed } from './feishuNotify.mjs';

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function safeTrim(s) {
  return String(s ?? '').trim();
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 */
async function loadFeishuAppCreds(supabase) {
  const envId = safeTrim(process.env.FEISHU_APP_ID);
  const envSecret = safeTrim(process.env.FEISHU_APP_SECRET);
  const envWeb = safeTrim(process.env.FEISHU_WEB_BASE_URL);
  const { data, error } = await supabase.from('system_settings').select('value').eq('key', 'feishu_config').maybeSingle();
  if (error) {
    log('WARN load feishu_config', error.message);
  }
  const v = data?.value && typeof data.value === 'object' ? /** @type {Record<string, unknown>} */ (data.value) : {};
  const appId = envId || (typeof v.appId === 'string' ? v.appId.trim() : '');
  const appSecret = envSecret || (typeof v.appSecret === 'string' ? String(v.appSecret).trim() : '');
  const webBaseUrl =
    envWeb ||
    (typeof v.webBaseUrl === 'string'
      ? v.webBaseUrl.trim()
      : typeof v.web_base_url === 'string'
        ? v.web_base_url.trim()
        : '');
  return { appId, appSecret, webBaseUrl };
}

/**
 * @param {string} appId
 * @param {string} appSecret
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
    throw new Error(`tenant_access_token 失败 HTTP ${res.status}：${body?.msg || text.slice(0, 200)}`);
  }
  return String(body.tenant_access_token);
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} jobId
 * @param {Record<string, unknown>} patch
 */
async function patchJob(supabase, jobId, patch) {
  const { error } = await supabase.from('bom_feishu_version_sheet_jobs').update(patch).eq('id', jobId);
  if (error) log('WARN patch version sheet job', jobId, error.message);
  if (patch?.status === 'failed') {
    const { data } = await supabase
      .from('bom_feishu_version_sheet_jobs')
      .select('batch_id')
      .eq('id', jobId)
      .maybeSingle();
    void notifyFeishuJobFailed(supabase, {
      jobType: '生成软件包清单',
      jobId,
      batchId: data?.batch_id ? String(data.batch_id) : undefined,
      message: typeof patch.message === 'string' ? patch.message : undefined,
    });
  }
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} rootAbs
 * @param {{ id: string, batch_id: string }} job
 */
export async function executeFeishuVersionSheetJob(supabase, rootAbs, job) {
  const jobId = job.id;
  const batchId = job.batch_id;

  const { appId, appSecret, webBaseUrl } = await loadFeishuAppCreds(supabase);
  if (!appId || !appSecret) {
    await patchJob(supabase, jobId, {
      status: 'failed',
      finished_at: new Date().toISOString(),
      message: '未配置飞书应用凭据',
    });
    return;
  }

  let hbTimer = null;
  try {
    await reportBomLocalRootRuntime(supabase, rootAbs, { phase: 'busy', busyHint: 'feishu-version-sheet' });
    hbTimer = setInterval(() => {
      void reportBomLocalRootRuntime(supabase, rootAbs, { phase: 'busy', busyHint: 'feishu-version-sheet' });
      void patchJob(supabase, jobId, { heartbeat_at: new Date().toISOString() });
    }, 15000);

    await patchJob(supabase, jobId, {
      message: '正在生成版本目录软件包清单表格…',
      heartbeat_at: new Date().toISOString(),
    });

    const accessToken = await feishuTenantToken(appId, appSecret);
    const result = await generateVersionPackageSheetForBatch(supabase, accessToken, batchId, { webBaseUrl });

    await patchJob(supabase, jobId, {
      status: 'succeeded',
      finished_at: new Date().toISOString(),
      message: `已生成「${result.sheetTitle || '软件包清单'}」：${result.rowCount} 行`,
      sheet_url: result.url || null,
      row_count: result.rowCount,
      heartbeat_at: new Date().toISOString(),
    });
    log('feishu-version-sheet-job done', jobId, { rows: result.rowCount, url: result.url });

    const { data: rerunId, error: rerunErr } = await supabase.rpc(
      'bom_finish_feishu_version_sheet_rerun_if_needed',
      { p_job_id: jobId },
    );
    if (rerunErr) {
      log('WARN version sheet rerun enqueue', jobId, rerunErr.message);
    } else if (rerunId) {
      log('feishu-version-sheet scheduled rerun', { afterJobId: jobId, nextJobId: rerunId, batchId });
    }
  } catch (e) {
    const msg = (e instanceof Error ? e.message : String(e)).slice(0, 2000);
    log('ERROR executeFeishuVersionSheetJob', jobId, msg);
    await patchJob(supabase, jobId, {
      status: 'failed',
      finished_at: new Date().toISOString(),
      message: msg,
    });
    // 失败也消化 needs_rerun，避免卡住；分批上传可再触发入队
    const { data: rerunId, error: rerunErr } = await supabase.rpc(
      'bom_finish_feishu_version_sheet_rerun_if_needed',
      { p_job_id: jobId },
    );
    if (rerunErr) {
      log('WARN version sheet rerun after fail', jobId, rerunErr.message);
    } else if (rerunId) {
      log('feishu-version-sheet scheduled rerun after fail', { afterJobId: jobId, nextJobId: rerunId });
    }
  } finally {
    if (hbTimer) clearInterval(hbTimer);
    await reportBomLocalRootRuntime(supabase, rootAbs, { phase: 'idle' });
  }
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} rootAbs
 */
export async function drainFeishuVersionSheetJobs(supabase, rootAbs) {
  for (;;) {
    const { data, error } = await supabase.rpc('bom_claim_feishu_version_sheet_job');
    if (error) {
      log('WARN bom_claim_feishu_version_sheet_job', error.message);
      break;
    }
    const rows = Array.isArray(data) ? data : data ? [data] : [];
    const first = rows[0];
    if (!first?.id) break;
    try {
      await executeFeishuVersionSheetJob(supabase, rootAbs, {
        id: first.id,
        batch_id: first.batch_id,
      });
    } catch (e) {
      const msg = (e instanceof Error ? e.message : String(e)).slice(0, 2000);
      log('ERROR drainFeishuVersionSheetJobs', first.id, msg);
      await patchJob(supabase, first.id, {
        status: 'failed',
        finished_at: new Date().toISOString(),
        message: msg,
      });
    }
  }
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {number} staleSec
 */
export async function failStaleFeishuVersionSheetJobs(supabase, staleSec) {
  const sec = Number.isFinite(staleSec) && staleSec >= 60 ? Math.floor(staleSec) : 3600;
  const { data, error } = await supabase.rpc('bom_fail_stale_feishu_version_sheet_jobs', {
    p_stale_seconds: sec,
  });
  if (error) {
    log('WARN bom_fail_stale_feishu_version_sheet_jobs', error.message);
    return;
  }
  const n = typeof data === 'number' ? data : Number(data);
  if (n > 0) log('bom_fail_stale_feishu_version_sheet_jobs', n);
}
