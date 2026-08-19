/**
 * Worker 侧飞书私聊通知（任务失败时）。
 * 读取 system_settings.feishu_config：notifyEnabled + notifyOpenIds + appId/appSecret。
 */

function log(...args) {
  console.log(new Date().toISOString(), '[feishu-notify]', ...args);
}

function parseOpenIds(raw) {
  if (Array.isArray(raw)) {
    return [...new Set(raw.map((x) => String(x ?? '').trim()).filter(Boolean))];
  }
  if (typeof raw === 'string') {
    return [
      ...new Set(
        raw
          .split(/[\s,，;；]+/)
          .map((s) => s.trim())
          .filter(Boolean),
      ),
    ];
  }
  return [];
}

async function fetchTenantToken(appId, appSecret) {
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
    throw new Error(`tenant_access_token 非 JSON：${text.slice(0, 160)}`);
  }
  if (!res.ok || body.code !== 0 || !body.tenant_access_token) {
    throw new Error(body?.msg || `tenant_access_token 失败 HTTP ${res.status}`);
  }
  return String(body.tenant_access_token);
}

async function sendTextToOpenId(token, openId, msg) {
  const u = new URL('https://open.feishu.cn/open-apis/im/v1/messages');
  u.searchParams.set('receive_id_type', 'open_id');
  const res = await fetch(u.toString(), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      receive_id: openId,
      msg_type: 'text',
      content: JSON.stringify({ text: msg }),
    }),
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`send_im 非 JSON：${text.slice(0, 120)}`);
  }
  if (!res.ok || body.code !== 0) {
    throw new Error(body?.msg || `send_im HTTP ${res.status}`);
  }
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} admin
 * @param {{ jobType: string, jobId?: string, batchId?: string, batchName?: string, message?: string }} info
 */
export async function notifyFeishuJobFailed(admin, info) {
  try {
    let batchName = info.batchName?.trim() || '';
    if (!batchName && info.batchId) {
      const { data: b } = await admin.from('bom_batches').select('name').eq('id', info.batchId).maybeSingle();
      if (b?.name) batchName = String(b.name);
    }

    const lines = [`【BOM】${info.jobType} · 失败`];
    if (batchName) lines.push(`版本：${batchName}`);
    if (info.jobId) lines.push(`任务：${String(info.jobId).trim()}`);
    if (info.message?.trim()) lines.push(info.message.trim().slice(0, 500));
    await sendFeishuNotifyText(admin, lines.join('\n'));
  } catch (e) {
    log('notify error', e instanceof Error ? e.message : String(e));
  }
}

/**
 * 读取 feishu_config 后按 notifyOpenIds 发纯文本。未启用或失败时静默。
 * @param {import('@supabase/supabase-js').SupabaseClient} admin
 * @param {string} text
 */
export async function sendFeishuNotifyText(admin, text) {
  const msg = String(text ?? '').trim();
  if (!msg) return;
  try {
    const { data, error } = await admin
      .from('system_settings')
      .select('value')
      .eq('key', 'feishu_config')
      .maybeSingle();
    if (error) {
      log('read feishu_config failed', error.message);
      return;
    }
    const v = (data?.value ?? {}) || {};
    if (v.notifyEnabled !== true) return;
    const openIds = parseOpenIds(v.notifyOpenIds ?? v.notify_open_ids);
    if (!openIds.length) return;
    const appId = typeof v.appId === 'string' ? v.appId.trim() : '';
    const appSecret = typeof v.appSecret === 'string' ? v.appSecret.trim() : '';
    if (!appId || !appSecret) {
      log('missing app credentials');
      return;
    }
    const token = await fetchTenantToken(appId, appSecret);
    for (const openId of openIds) {
      try {
        await sendTextToOpenId(token, openId, msg);
      } catch (e) {
        log('send failed', openId, e instanceof Error ? e.message : String(e));
      }
    }
  } catch (e) {
    log('notify error', e instanceof Error ? e.message : String(e));
  }
}
