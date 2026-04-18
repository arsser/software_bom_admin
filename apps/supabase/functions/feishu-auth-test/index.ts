import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const FEISHU_SETTINGS_KEY = 'feishu_config'
const TOKEN_URL = 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal'
const TIMEOUT_MS = 15000

type FeishuConfigRow = {
  appId?: string
  appSecret?: string
}

type FeishuListFile = {
  name?: string
  token?: string
  type?: string
}

function safeTrim(s: unknown): string {
  return typeof s === 'string' ? s.trim() : ''
}

async function readDbFeishuConfig(): Promise<{ appId: string; appSecret: string }> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!supabaseUrl || !serviceKey) {
    throw new Error('Edge 缺少 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY，无法读取数据库凭据')
  }
  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data, error } = await admin
    .from('system_settings')
    .select('value')
    .eq('key', FEISHU_SETTINGS_KEY)
    .maybeSingle()
  if (error) throw new Error(`读取 feishu_config 失败: ${error.message}`)
  const v = (data?.value ?? {}) as FeishuConfigRow
  return {
    appId: typeof v.appId === 'string' ? v.appId.trim() : '',
    appSecret: typeof v.appSecret === 'string' ? v.appSecret.trim() : '',
  }
}

type TenantOk = {
  ok: true
  accessToken: string
  httpStatus: number
  expireSeconds?: number
}

type TenantErr = { ok: false; httpStatus?: number; error: string }

async function fetchTenantAccessToken(appId: string, appSecret: string): Promise<TenantOk | TenantErr> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS)
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    signal: controller.signal,
  })
  clearTimeout(timeout)

  const text = await res.text()
  let parsed: { code?: number; msg?: string; tenant_access_token?: string; expire?: number }
  try {
    parsed = JSON.parse(text) as typeof parsed
  } catch {
    return { ok: false, httpStatus: res.status, error: `飞书 token 响应非 JSON：${text.slice(0, 200)}` }
  }
  if (!res.ok || parsed.code !== 0 || !parsed.tenant_access_token) {
    return {
      ok: false,
      httpStatus: res.status,
      error: parsed.msg || `获取 tenant_access_token 失败 HTTP ${res.status}`,
    }
  }
  const expireSeconds =
    typeof parsed.expire === 'number' && Number.isFinite(parsed.expire) ? parsed.expire : undefined
  return {
    ok: true,
    accessToken: parsed.tenant_access_token,
    httpStatus: res.status,
    expireSeconds,
  }
}

/** 仅取第一页，避免测试请求过大 */
async function listDriveFolderFirstPage(
  accessToken: string,
  folderToken: string,
): Promise<{
  httpStatus: number
  files: FeishuListFile[]
  has_more?: boolean
  next_page_token?: string
  raw: unknown
}> {
  const u = new URL('https://open.feishu.cn/open-apis/drive/v1/files')
  u.searchParams.set('folder_token', folderToken)
  /** 飞书单页 page_size 上限 50 */
  u.searchParams.set('page_size', '50')
  const res = await fetch(u.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  const text = await res.text()
  let parsed: {
    code?: number
    msg?: string
    log_id?: string
    data?: { files?: FeishuListFile[]; has_more?: boolean; next_page_token?: string }
  }
  try {
    parsed = JSON.parse(text) as typeof parsed
  } catch {
    throw new Error(`列出文件夹响应非 JSON：${text.slice(0, 200)}`)
  }
  const files = Array.isArray(parsed.data?.files) ? parsed.data!.files! : []
  if (!res.ok || parsed.code !== 0) {
    const base = parsed.msg || `列出文件夹失败 HTTP ${res.status}`
    const parts = [base]
    if (typeof parsed.code === 'number' && Number.isFinite(parsed.code)) {
      parts.push(`飞书错误码 ${parsed.code}`)
    }
    if (typeof parsed.log_id === 'string' && parsed.log_id.trim()) {
      parts.push(`log_id ${parsed.log_id.trim()}`)
    }
    throw new Error(parts.join(' · '))
  }
  return {
    httpStatus: res.status,
    files,
    has_more: parsed.data?.has_more,
    next_page_token: parsed.data?.next_page_token,
    raw: parsed,
  }
}

/** 在指定父文件夹下创建子文件夹（与官方 create_folder 一致） */
async function createDriveChildFolder(
  accessToken: string,
  parentFolderToken: string,
  name: string,
): Promise<{ httpStatus: number; token: string; url?: string; raw: unknown }> {
  const res = await fetch('https://open.feishu.cn/open-apis/drive/v1/files/create_folder', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({ folder_token: parentFolderToken, name }),
  })
  const text = await res.text()
  let parsed: {
    code?: number
    msg?: string
    log_id?: string
    data?: { token?: string; url?: string }
  }
  try {
    parsed = JSON.parse(text) as typeof parsed
  } catch {
    throw new Error(`创建文件夹响应非 JSON：${text.slice(0, 200)}`)
  }
  if (!res.ok || parsed.code !== 0) {
    const base = parsed.msg || `创建文件夹失败 HTTP ${res.status}`
    const parts = [base]
    if (typeof parsed.code === 'number' && Number.isFinite(parsed.code)) {
      parts.push(`飞书错误码 ${parsed.code}`)
    }
    if (typeof parsed.log_id === 'string' && parsed.log_id.trim()) {
      parts.push(`log_id ${parsed.log_id.trim()}`)
    }
    throw new Error(parts.join(' · '))
  }
  const token = parsed.data?.token
  if (typeof token !== 'string' || !token.trim()) {
    throw new Error('创建成功但未返回子文件夹 token')
  }
  const url = typeof parsed.data?.url === 'string' ? parsed.data.url : undefined
  return { httpStatus: res.status, token: token.trim(), url, raw: parsed }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ ok: false, error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' },
    })
  }

  try {
    let raw: Record<string, unknown> = {}
    try {
      raw = (await req.json()) as Record<string, unknown>
    } catch {
      raw = {}
    }

    const action = safeTrim(raw.action) || 'auth'
    const folderToken = safeTrim(raw.folderToken)
    const childFolderNameRaw = typeof raw.childFolderName === 'string' ? raw.childFolderName.trim() : ''

    const fromId = safeTrim(raw.appId)
    const fromSecret = typeof raw.appSecret === 'string' ? raw.appSecret.trim() : ''
    const useFormPreview = Boolean(fromId && fromSecret)

    let appId: string
    let appSecret: string
    if (useFormPreview) {
      appId = fromId
      appSecret = fromSecret
    } else {
      const db = await readDbFeishuConfig()
      appId = db.appId
      appSecret = db.appSecret
    }

    if (!appId || !appSecret) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: useFormPreview
            ? '请填写 App ID 与 App Secret'
            : '数据库中未配置飞书 appId / appSecret；请在表单填写两项后测试，或先保存',
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' } },
      )
    }

    const tenant = await fetchTenantAccessToken(appId, appSecret)
    if (!tenant.ok) {
      return new Response(
        JSON.stringify({
          ok: false,
          action,
          httpStatus: tenant.httpStatus,
          error: tenant.error,
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' } },
      )
    }

    if (action === 'list_drive') {
      if (!folderToken) {
        return new Response(
          JSON.stringify({ ok: false, action, error: '缺少 folderToken（云盘父文件夹 token）' }),
          { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' } },
        )
      }
      try {
        const list = await listDriveFolderFirstPage(tenant.accessToken, folderToken)
        const items = list.files.map((f) => ({
          name: f.name,
          type: f.type,
          token: f.token,
        }))
        return new Response(
          JSON.stringify({
            ok: true,
            action: 'list_drive',
            listHttpStatus: list.httpStatus,
            itemCount: items.length,
            items,
            hasMore: list.has_more,
            nextPageToken: list.next_page_token ?? null,
            /** 飞书 list 接口解析后的完整 JSON（便于核对） */
            raw: list.raw,
          }),
          { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' } },
        )
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        return new Response(
          JSON.stringify({ ok: false, action: 'list_drive', error: msg }),
          { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' } },
        )
      }
    }

    if (action === 'create_folder') {
      if (!folderToken) {
        return new Response(
          JSON.stringify({ ok: false, action: 'create_folder', error: '缺少 folderToken（父文件夹 token，与「测试飞书根目录」相同）' }),
          { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' } },
        )
      }
      let name = childFolderNameRaw
      if (!name) {
        name = `sbom-test-${Date.now()}-${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`
      }
      const nameBytes = new TextEncoder().encode(name).length
      if (nameBytes < 1 || nameBytes > 256) {
        return new Response(
          JSON.stringify({
            ok: false,
            action: 'create_folder',
            error: `子文件夹名称长度须为 1～256 字节（当前 ${nameBytes} 字节）`,
          }),
          { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' } },
        )
      }
      try {
        const created = await createDriveChildFolder(tenant.accessToken, folderToken, name)
        return new Response(
          JSON.stringify({
            ok: true,
            action: 'create_folder',
            createHttpStatus: created.httpStatus,
            usedName: name,
            newFolderToken: created.token,
            newFolderUrl: created.url ?? null,
            raw: created.raw,
          }),
          { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' } },
        )
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        return new Response(
          JSON.stringify({ ok: false, action: 'create_folder', error: msg }),
          { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' } },
        )
      }
    }

    return new Response(
      JSON.stringify({
        ok: true,
        action: 'auth',
        httpStatus: tenant.httpStatus,
        expireSeconds: tenant.expireSeconds,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' } },
    )
  } catch (e: unknown) {
    const err = e as { name?: string; message?: string }
    let msg = err.message || String(e)
    if (err.name === 'AbortError') msg = '请求飞书超时'
    return new Response(JSON.stringify({ ok: false, error: msg }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' },
    })
  }
})
