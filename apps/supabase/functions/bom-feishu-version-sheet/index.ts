import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' },
  })
}

function safeTrim(s: unknown): string {
  return String(s ?? '').trim()
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
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  if (!supabaseUrl || !anonKey || !serviceKey) {
    return jsonResponse({ ok: false, error: 'Edge 缺少 SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY' }, 500)
  }

  let batchId = ''
  try {
    const body = (await req.json()) as { batchId?: string }
    batchId = safeTrim(body.batchId)
    if (!batchId) throw new Error('缺少 batchId')
  } catch (e) {
    return jsonResponse({ ok: false, error: e instanceof Error ? e.message : '请求体无效' }, 400)
  }

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data: authData, error: authErr } = await userClient.auth.getUser()
  if (authErr || !authData.user?.id) {
    return jsonResponse({ ok: false, error: '未登录或会话无效' }, 401)
  }

  const { data: batch, error: batchErr } = await userClient
    .from('bom_batches')
    .select('id,name,product_id')
    .eq('id', batchId)
    .maybeSingle()
  if (batchErr || !batch) {
    return jsonResponse({ ok: false, error: batchErr?.message || '无权限或批次不存在' }, 403)
  }

  const svc = createClient(supabaseUrl, serviceKey, {
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
  if (!safeTrim(productRow?.feishu_drive_root_folder_token)) {
    return jsonResponse({ ok: false, error: '未配置飞书存储根目录 folder_token（产品分发配置）' }, 400)
  }

  // 与 worker 上传后自动入队同一 RPC：queued 复用；running 则 needs_rerun
  const { data: jobId, error: enqErr } = await svc.rpc('bom_enqueue_feishu_version_sheet', {
    p_batch_id: batchId,
    p_trigger_source: 'edge',
  })
  if (enqErr || !jobId) {
    return jsonResponse({ ok: false, error: enqErr?.message || '无法创建清单任务' }, 500)
  }

  const { data: jobRow } = await svc
    .from('bom_feishu_version_sheet_jobs')
    .select('id,status,needs_rerun')
    .eq('id', jobId)
    .maybeSingle()

  const st = typeof jobRow?.status === 'string' ? jobRow.status : ''
  const reused = st === 'queued' || st === 'running'
  const pendingRerun = Boolean(jobRow?.needs_rerun)

  return jsonResponse({
    ok: true,
    async: true,
    jobId: String(jobId),
    batchId,
    reused,
    message: pendingRerun
      ? '已有清单任务进行中，结束后将自动再生成一次（纳入新上传行）'
      : reused
        ? `已有进行中的生成任务（${st}）`
        : '已排队生成版本目录「软件包清单」电子表格，由 bom-scanner-worker 执行',
  })
})
