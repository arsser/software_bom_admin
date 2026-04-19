import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function jsonResponse(body: unknown, status = 200): Response {
  try {
    if (status >= 400) {
      const errMsg =
        body && typeof body === 'object' && 'error' in (body as object)
          ? String((body as { error: unknown }).error)
          : JSON.stringify(body).slice(0, 800)
      console.error(`[bom-feishu-scan] HTTP ${status}:`, errMsg)
    } else if (
      body &&
      typeof body === 'object' &&
      (body as { ok?: unknown }).ok === false &&
      'error' in (body as object)
    ) {
      console.warn(`[bom-feishu-scan] HTTP ${status} ok=false:`, String((body as { error: unknown }).error))
    }
  } catch {
    /* 日志失败不影响响应 */
  }
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' },
  })
}

function safeTrim(s: unknown): string {
  return String(s ?? '').trim()
}

function normalizePathSegmentValue(seg: unknown): string {
  return String(seg ?? '')
    .normalize('NFKC')
    .replace(/[\u200b-\u200d\ufeff\u3000]/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

function safePathSegment(seg: string): string {
  const t = normalizePathSegmentValue(seg)
    .replace(/[/\\?*:|"<>]/g, '_')
    .replace(/\s+/g, ' ')
    .slice(0, 160)
  return t || 'unknown'
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  if (req.method !== 'POST') {
    return jsonResponse({ ok: false, error: 'Method not allowed' }, 405)
  }

  const authHeader = req.headers.get('Authorization') ?? ''
  if (!authHeader.startsWith('Bearer ')) {
    return jsonResponse({ ok: false, error: '缺少 Authorization Bearer' }, 401)
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
  if (!supabaseUrl || !anonKey) {
    return jsonResponse({ ok: false, error: 'Edge 缺少 SUPABASE_URL / SUPABASE_ANON_KEY' }, 500)
  }

  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

  async function resolveFeishuAppCreds(): Promise<{ appId: string; appSecret: string }> {
    const envId = safeTrim(Deno.env.get('FEISHU_APP_ID'))
    const envSecret = safeTrim(Deno.env.get('FEISHU_APP_SECRET'))
    if (envId && envSecret) return { appId: envId, appSecret: envSecret }
    if (!supabaseUrl || !supabaseServiceKey) {
      return { appId: '', appSecret: '' }
    }
    const admin = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
    const { data, error } = await admin.from('system_settings').select('value').eq('key', 'feishu_config').maybeSingle()
    if (error) {
      console.warn('read feishu_config:', error.message)
      return { appId: '', appSecret: '' }
    }
    const v = (data?.value ?? {}) as Record<string, unknown>
    return {
      appId: typeof v.appId === 'string' ? v.appId.trim() : '',
      appSecret: typeof v.appSecret === 'string' ? String(v.appSecret).trim() : '',
    }
  }

  const { appId, appSecret } = await resolveFeishuAppCreds()
  if (!appId || !appSecret) {
    return jsonResponse({
      ok: false,
      error:
        '未配置飞书应用凭据：请在环境变量设置 FEISHU_APP_ID / FEISHU_APP_SECRET，或在「系统设置 → 飞书」中填写并保存 feishu_config。',
    }, 200)
  }

  let batchId: string
  let autoCreateVersionFolder = false
  try {
    const body = (await req.json()) as { batchId?: string; autoCreateVersionFolder?: boolean }
    batchId = safeTrim(body.batchId)
    if (!batchId) throw new Error('缺少 batchId')
    autoCreateVersionFolder = Boolean(body.autoCreateVersionFolder)
  } catch (e) {
    return jsonResponse({ ok: false, error: e instanceof Error ? e.message : '请求体无效' }, 400)
  }

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const { data: batch, error: batchErr } = await userClient
    .from('bom_batches')
    .select('id,name,product_id')
    .eq('id', batchId)
    .maybeSingle()

  if (batchErr || !batch) {
    return jsonResponse({ ok: false, error: batchErr?.message || '无权限或批次不存在' }, 403)
  }

  if (!supabaseServiceKey) {
    return jsonResponse({ ok: false, error: 'Edge 缺少 SUPABASE_SERVICE_ROLE_KEY' }, 500)
  }
  const svc = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const { data: productRow, error: productErr } = await svc
    .from('products')
    .select('feishu_drive_root_folder_token')
    .eq('id', batch.product_id)
    .maybeSingle()
  if (productErr) {
    return jsonResponse({ ok: false, error: `读取产品配置失败：${productErr.message}` }, 500)
  }
  const rootFolder = safeTrim(productRow?.feishu_drive_root_folder_token)
  if (!rootFolder) {
    return jsonResponse({ ok: false, error: '未配置飞书存储根目录 folder_token（产品分发配置）' }, 400)
  }

  const { count: rowsTotal, error: rowsErr } = await svc
    .from('bom_rows')
    .select('*', { count: 'exact', head: true })
    .eq('batch_id', batchId)

  if (rowsErr) {
    return jsonResponse({ ok: false, error: rowsErr.message }, 500)
  }

  const nRows = typeof rowsTotal === 'number' ? rowsTotal : 0

  const { data: jobIns, error: jobInsErr } = await svc
    .from('bom_feishu_scan_jobs')
    .insert({
      batch_id: batchId,
      status: 'queued',
      trigger_source: 'edge',
      message: null,
      rows_total: nRows,
      rows_present: 0,
      rows_absent: 0,
      rows_error: 0,
      started_at: null,
      auto_create_version_folder: autoCreateVersionFolder,
    })
    .select('id')
    .single()

  if (jobInsErr || !jobIns?.id) {
    if (jobInsErr) console.error('[bom-feishu-scan] insert:', jobInsErr.code, jobInsErr.message, jobInsErr)
    return jsonResponse({ ok: false, error: jobInsErr?.message || '无法创建扫描任务' }, 500)
  }

  const jobId = jobIns.id as string
  const batchDir = safePathSegment(safeTrim(batch.name) || `batch-${batchId.replace(/-/g, '').slice(0, 8)}`)
  console.info(
    '[bom-feishu-scan] enqueued job',
    jobId,
    'batch',
    batchId,
    'rows_total',
    nRows,
    'versionDir',
    batchDir,
    'autoCreateVersionFolder',
    autoCreateVersionFolder,
  )

  return jsonResponse({
    ok: true,
    async: true,
    jobId,
    batchId,
    rows_total: nRows,
    message: `已排队飞书扫描（共 ${nRows} 行），由 bom-scanner-worker 执行；完成后请在页面查看结果或「后台任务」。`,
  })
})
