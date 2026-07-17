/**
 * 飞书 package-manifest.json 扫描刷新任务（产品维度）。
 */

import { safeFlatFilename } from './extArtifactorySync.mjs';
import {
  packageManifestToJson,
  rebuildFeishuPackageManifestFromDrive,
} from './feishuPackageManifest.mjs';
import { reportBomLocalRootRuntime } from './workerRuntimeReport.mjs';

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
  if (envId && envSecret) return { appId: envId, appSecret: envSecret };
  const { data, error } = await supabase.from('system_settings').select('value').eq('key', 'feishu_config').maybeSingle();
  if (error) {
    log('WARN load feishu_config', error.message);
    return { appId: '', appSecret: '' };
  }
  const v = data?.value && typeof data.value === 'object' ? /** @type {Record<string, unknown>} */ (data.value) : {};
  return {
    appId: typeof v.appId === 'string' ? v.appId.trim() : '',
    appSecret: typeof v.appSecret === 'string' ? String(v.appSecret).trim() : '',
  };
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
async function patchManifestJob(supabase, jobId, patch) {
  const { error } = await supabase.from('bom_feishu_manifest_jobs').update(patch).eq('id', jobId);
  if (error) log('WARN patchManifestJob', jobId, error.message);
}

/**
 * basename → { md5, sizeBytes }（文件名不重名假设下取首个）。
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 */
async function loadLocalFileIndexByBasename(supabase) {
  /** @type {Map<string, { md5: string, sizeBytes: number }>} */
  const byName = new Map();
  const pageSize = 1000;
  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from('local_file')
      .select('md5,path,size_bytes')
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`读取 local_file 失败：${error.message}`);
    const rows = data ?? [];
    if (!rows.length) break;
    for (const row of rows) {
      const md5 = String(row.md5 ?? '').trim().toLowerCase();
      const p = String(row.path ?? '').trim().replace(/\\/g, '/');
      const szRaw = row.size_bytes;
      const sz = typeof szRaw === 'string' ? Number(szRaw) : Number(szRaw);
      if (!/^[a-f0-9]{32}$/.test(md5) || !p || !Number.isFinite(sz) || sz < 0) continue;
      const base = safeFlatFilename(p.split('/').pop() || p).normalize('NFKC');
      if (!base || byName.has(base)) continue;
      byName.set(base, { md5, sizeBytes: Math.trunc(sz) });
    }
    if (rows.length < pageSize) break;
    from += pageSize;
  }
  return byName;
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} rootAbs
 * @param {{ id: string, product_id: string }} job
 */
export async function executeFeishuManifestJob(supabase, rootAbs, job) {
  const jobId = job.id;
  const productId = job.product_id;

  const { data: product, error: prodErr } = await supabase
    .from('products')
    .select('id,name,feishu_drive_root_folder_token')
    .eq('id', productId)
    .maybeSingle();
  if (prodErr || !product) {
    await patchManifestJob(supabase, jobId, {
      status: 'failed',
      finished_at: new Date().toISOString(),
      message: prodErr?.message || '产品不存在',
    });
    return;
  }

  const rootFolder = safeTrim(product.feishu_drive_root_folder_token);
  if (!rootFolder) {
    await patchManifestJob(supabase, jobId, {
      status: 'failed',
      finished_at: new Date().toISOString(),
      message: '未配置飞书云盘根目录 folder_token',
    });
    return;
  }

  const { appId, appSecret } = await loadFeishuAppCreds(supabase);
  if (!appId || !appSecret) {
    await patchManifestJob(supabase, jobId, {
      status: 'failed',
      finished_at: new Date().toISOString(),
      message: '未配置飞书应用凭据',
    });
    return;
  }

  let hbTimer = null;
  try {
    await reportBomLocalRootRuntime(supabase, rootAbs, { phase: 'busy', busyHint: 'feishu-manifest' });

    hbTimer = setInterval(() => {
      void reportBomLocalRootRuntime(supabase, rootAbs, { phase: 'busy', busyHint: 'feishu-manifest' });
      void patchManifestJob(supabase, jobId, {
        heartbeat_at: new Date().toISOString(),
      });
    }, 15000);

    await patchManifestJob(supabase, jobId, {
      message: '正在连接飞书并扫描云盘…',
      heartbeat_at: new Date().toISOString(),
    });

    const accessToken = await feishuTenantToken(appId, appSecret);
    const localByFileName = await loadLocalFileIndexByBasename(supabase);

    const result = await rebuildFeishuPackageManifestFromDrive(accessToken, rootFolder, {
      localByFileName,
      onProgress: async ({ message }) => {
        await patchManifestJob(supabase, jobId, {
          message: String(message).slice(0, 2000),
          heartbeat_at: new Date().toISOString(),
        });
      },
    });

    const summary = `完成：扫描 ${result.filesFound} 个文件，写入清单 ${result.state.entries.length} 条（含 MD5 ${result.withMd5}，缺 MD5 ${result.withoutMd5}）`;
    await patchManifestJob(supabase, jobId, {
      status: 'succeeded',
      finished_at: new Date().toISOString(),
      message: summary.slice(0, 2000),
      files_total: result.filesFound,
      files_with_md5: result.withMd5,
      files_without_md5: result.withoutMd5,
      heartbeat_at: new Date().toISOString(),
    });
    log('feishu-manifest-job done', jobId, {
      product: product.name,
      summary,
      entryCount: packageManifestToJson(result.state).entries.length,
    });
  } catch (e) {
    const msg = (e instanceof Error ? e.message : String(e)).slice(0, 2000);
    log('ERROR executeFeishuManifestJob', jobId, msg);
    await patchManifestJob(supabase, jobId, {
      status: 'failed',
      finished_at: new Date().toISOString(),
      message: msg,
    });
  } finally {
    if (hbTimer) clearInterval(hbTimer);
    await reportBomLocalRootRuntime(supabase, rootAbs, { phase: 'idle' });
  }
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} rootAbs
 */
export async function drainFeishuManifestJobs(supabase, rootAbs) {
  for (;;) {
    const { data, error } = await supabase.rpc('bom_claim_feishu_manifest_job');
    if (error) {
      log('WARN bom_claim_feishu_manifest_job', error.message);
      break;
    }
    const rows = Array.isArray(data) ? data : data ? [data] : [];
    const first = rows[0];
    if (!first?.id) break;
    try {
      await executeFeishuManifestJob(supabase, rootAbs, {
        id: first.id,
        product_id: first.product_id,
      });
    } catch (e) {
      const msg = (e instanceof Error ? e.message : String(e)).slice(0, 2000);
      log('ERROR drainFeishuManifestJobs', first.id, msg);
      await patchManifestJob(supabase, first.id, {
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
export async function failStaleFeishuManifestJobs(supabase, staleSec) {
  const sec = Number.isFinite(staleSec) && staleSec >= 60 ? Math.floor(staleSec) : 7200;
  const { data, error } = await supabase.rpc('bom_fail_stale_feishu_manifest_jobs', { p_stale_seconds: sec });
  if (error) {
    log('WARN bom_fail_stale_feishu_manifest_jobs', error.message);
    return;
  }
  const n = typeof data === 'number' ? data : Number(data);
  if (n > 0) log('bom_fail_stale_feishu_manifest_jobs', n);
}
