import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const META_DIR = 'meta'
const MANIFEST_FILE_NAME = 'package-manifest.json'
/** 与 bom-scanner-worker feishuVersionSheet.VERSION_PACKAGE_SHEET_TITLE 一致 */
const VERSION_PACKAGE_SHEET_TITLE = '软件包清单'
const FEISHU_LIST_FOLDER_PAGE_SIZE = 50
const TIMEOUT_MS = 30000

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' },
  })
}

function safeTrim(s: unknown): string {
  return String(s ?? '').trim()
}

function buildFeishuFileDownloadUrl(fileToken: string): string {
  const tok = safeTrim(fileToken)
  if (!tok) return ''
  return `https://open.feishu.cn/open-apis/drive/v1/files/${encodeURIComponent(tok)}/download`
}

function normalizeFeishuWebBaseUrl(raw: unknown): string {
  let s = String(raw ?? '')
    .trim()
    .replace(/\/+$/, '')
  if (!s) return ''
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`
  try {
    const u = new URL(s)
    if (/^open\./i.test(u.hostname)) return ''
    return `${u.protocol}//${u.host}`
  } catch {
    return ''
  }
}

function buildFeishuFileWebUrl(fileToken: string, webBaseUrl: string): string {
  const tok = safeTrim(fileToken)
  const base = normalizeFeishuWebBaseUrl(webBaseUrl)
  if (!tok || !base) return ''
  return `${base}/file/${encodeURIComponent(tok)}`
}

function buildFeishuSheetWebUrl(sheetToken: string, webBaseUrl: string): string {
  const tok = safeTrim(sheetToken)
  const base = normalizeFeishuWebBaseUrl(webBaseUrl)
  if (!tok || !base) return ''
  return `${base}/sheets/${encodeURIComponent(tok)}`
}

/** 与 worker safePathSegment 对齐，用于批次名 ↔ 一级目录名匹配 */
function safePathSegment(seg: unknown): string {
  const t = safeTrim(seg)
    .normalize('NFKC')
    .replace(/[/\\?*:|"<>]/g, '_')
    .replace(/\s+/g, ' ')
    .slice(0, 160)
  return t || 'unknown'
}

function resolvePackageManifestDownloadUrl(
  fileToken: string,
  webBaseUrl: string,
  existingUrl?: string,
): string {
  const web = buildFeishuFileWebUrl(fileToken, webBaseUrl)
  if (web) return web
  const existing = safeTrim(existingUrl)
  if (existing && !/open\.feishu\.cn\/open-apis\//i.test(existing)) return existing
  return ''
}

async function resolveFeishuAppCreds(
  supabaseUrl: string,
  serviceKey: string,
): Promise<{ appId: string; appSecret: string; webBaseUrl: string }> {
  const envId = safeTrim(Deno.env.get('FEISHU_APP_ID'))
  const envSecret = safeTrim(Deno.env.get('FEISHU_APP_SECRET'))
  const envWeb = safeTrim(Deno.env.get('FEISHU_WEB_BASE_URL'))
  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data, error } = await admin.from('system_settings').select('value').eq('key', 'feishu_config').maybeSingle()
  if (error) {
    console.warn('read feishu_config:', error.message)
  }
  const v = (data?.value ?? {}) as Record<string, unknown>
  const appId = envId || (typeof v.appId === 'string' ? v.appId.trim() : '')
  const appSecret = envSecret || (typeof v.appSecret === 'string' ? String(v.appSecret).trim() : '')
  const webBaseUrl = normalizeFeishuWebBaseUrl(
    envWeb ||
      (typeof v.webBaseUrl === 'string'
        ? v.webBaseUrl
        : typeof v.web_base_url === 'string'
          ? v.web_base_url
          : ''),
  )
  return { appId, appSecret, webBaseUrl }
}

async function feishuTenantToken(appId: string, appSecret: string): Promise<string> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      signal: controller.signal,
    })
    const text = await res.text()
    let body: { code?: number; msg?: string; tenant_access_token?: string }
    try {
      body = JSON.parse(text)
    } catch {
      throw new Error(`飞书 token 响应非 JSON：${text.slice(0, 200)}`)
    }
    if (!res.ok || body.code !== 0 || !body.tenant_access_token) {
      throw new Error(`换取 token 失败 HTTP ${res.status}：${body.msg || text.slice(0, 200)}`)
    }
    return String(body.tenant_access_token)
  } finally {
    clearTimeout(timeout)
  }
}

async function listFolderPage(accessToken: string, folderToken: string, pageToken?: string) {
  const u = new URL('https://open.feishu.cn/open-apis/drive/v1/files')
  u.searchParams.set('folder_token', folderToken)
  u.searchParams.set('page_size', String(FEISHU_LIST_FOLDER_PAGE_SIZE))
  if (pageToken) u.searchParams.set('page_token', pageToken)
  const res = await fetch(u.toString(), { headers: { Authorization: `Bearer ${accessToken}` } })
  const text = await res.text()
  let body: { code?: number; msg?: string; data?: { files?: unknown[]; has_more?: boolean; next_page_token?: string } }
  try {
    body = JSON.parse(text)
  } catch {
    throw new Error(`列出文件夹响应非 JSON：${text.slice(0, 200)}`)
  }
  if (!res.ok || body.code !== 0) {
    throw new Error(`list_folder 失败 HTTP ${res.status}：${body.msg || text.slice(0, 200)}`)
  }
  return {
    files: Array.isArray(body.data?.files) ? body.data!.files! : [],
    has_more: Boolean(body.data?.has_more),
    page_token: body.data?.next_page_token,
  }
}

async function listAllInFolder(accessToken: string, folderToken: string) {
  const out: Array<{ name?: string; token?: string; type?: string }> = []
  let pageToken: string | undefined
  do {
    const page = await listFolderPage(accessToken, folderToken, pageToken)
    out.push(...(page.files as Array<{ name?: string; token?: string; type?: string }>))
    pageToken = page.has_more && page.page_token ? page.page_token : undefined
  } while (pageToken)
  return out
}

function findChildFolderToken(
  items: Array<{ name?: string; token?: string; type?: string }>,
  folderName: string,
): string | null {
  const want = safeTrim(folderName).normalize('NFKC')
  if (!want) return null
  for (const it of items) {
    if (safeTrim(it.type) !== 'folder') continue
    if (safeTrim(it.name).normalize('NFKC') === want) {
      const tok = safeTrim(it.token)
      if (tok) return tok
    }
  }
  return null
}

async function downloadFileText(accessToken: string, fileToken: string): Promise<string> {
  const url = buildFeishuFileDownloadUrl(fileToken)
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`下载清单失败 HTTP ${res.status}：${text.slice(0, 300)}`)
  }
  return await res.text()
}

function normalizeManifestJson(
  rawText: string,
  webBaseUrl = '',
): {
  version: number
  updated_at: string | null
  entries: Array<Record<string, unknown>>
} {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawText)
  } catch {
    return { version: 1, updated_at: null, entries: [] }
  }
  const obj = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  const list = Array.isArray(obj.entries)
    ? obj.entries
    : Array.isArray(obj.files)
      ? obj.files
      : Array.isArray(parsed)
        ? parsed
        : []
  const entries: Array<Record<string, unknown>> = []
  for (const item of list) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const o = item as Record<string, unknown>
    const fileToken = safeTrim(o.file_token || o.fileToken)
    if (!fileToken) continue
    const downloadUrl = resolvePackageManifestDownloadUrl(
      fileToken,
      webBaseUrl,
      safeTrim(o.download_url || o.downloadUrl),
    )
    entries.push({
      ...o,
      file_token: fileToken,
      download_url: downloadUrl,
    })
  }
  return {
    version: typeof obj.version === 'number' ? obj.version : 1,
    updated_at: typeof obj.updated_at === 'string' ? obj.updated_at : null,
    entries,
  }
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
  if (!supabaseUrl || !anonKey) {
    return jsonResponse({ ok: false, error: 'Edge 缺少 SUPABASE_URL / SUPABASE_ANON_KEY' }, 500)
  }
  if (!serviceKey) {
    return jsonResponse({ ok: false, error: 'Edge 缺少 SUPABASE_SERVICE_ROLE_KEY' }, 500)
  }

  let action = 'get'
  let productId = ''
  try {
    const body = (await req.json()) as { action?: string; productId?: string }
    action = safeTrim(body.action || 'get').toLowerCase() || 'get'
    productId = safeTrim(body.productId)
    if (!productId) throw new Error('缺少 productId')
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
  const userId = authData.user.id

  const { data: product, error: productErr } = await userClient
    .from('products')
    .select('id,name,feishu_drive_root_folder_token')
    .eq('id', productId)
    .maybeSingle()
  if (productErr || !product) {
    return jsonResponse({ ok: false, error: productErr?.message || '无权限或产品不存在' }, 403)
  }
  const rootFolder = safeTrim(product.feishu_drive_root_folder_token)
  if (!rootFolder) {
    return jsonResponse({ ok: false, error: '未配置飞书云盘根目录 folder_token（产品分发配置）' }, 400)
  }

  const { appId, appSecret, webBaseUrl } = await resolveFeishuAppCreds(supabaseUrl, serviceKey)
  if (!appId || !appSecret) {
    return jsonResponse({
      ok: false,
      error: '未配置飞书应用凭据：请设置 FEISHU_APP_ID/FEISHU_APP_SECRET 或 system_settings.feishu_config',
    }, 200)
  }

  if (action === 'refresh') {
    const svc = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
    const { data: active } = await svc
      .from('bom_feishu_manifest_jobs')
      .select('id,status')
      .eq('product_id', productId)
      .in('status', ['queued', 'running'])
      .order('requested_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (active?.id) {
      return jsonResponse({
        ok: true,
        async: true,
        jobId: active.id,
        productId,
        message: `已有进行中的扫描任务（${active.status}），请等待完成后再试或直接查看进度`,
        reused: true,
      })
    }

    const { data: jobIns, error: jobInsErr } = await svc
      .from('bom_feishu_manifest_jobs')
      .insert({
        product_id: productId,
        user_id: userId,
        status: 'queued',
        trigger_source: 'edge',
        message: null,
      })
      .select('id')
      .single()
    if (jobInsErr || !jobIns?.id) {
      return jsonResponse({ ok: false, error: jobInsErr?.message || '无法创建扫描任务' }, 500)
    }
    return jsonResponse({
      ok: true,
      async: true,
      jobId: jobIns.id,
      productId,
      message: '已排队扫描并刷新 package-manifest.json，由 bom-scanner-worker 执行',
    })
  }

  if (action === 'list_dirs') {
    try {
      const accessToken = await feishuTenantToken(appId, appSecret)
      const rootItems = await listAllInFolder(accessToken, rootFolder)
      const { data: batches, error: batchesErr } = await userClient
        .from('bom_batches')
        .select('id,name,created_at')
        .eq('product_id', productId)
        .order('created_at', { ascending: false })
      if (batchesErr) {
        return jsonResponse({ ok: false, error: `读取批次失败：${batchesErr.message}` }, 500)
      }
      const batchByDir = new Map<string, { id: string; name: string }>()
      for (const b of batches ?? []) {
        const id = safeTrim(b.id)
        const name = safeTrim(b.name)
        if (!id || !name) continue
        const key = safePathSegment(name).normalize('NFKC')
        if (!batchByDir.has(key)) batchByDir.set(key, { id, name })
      }

      const wantSheet = VERSION_PACKAGE_SHEET_TITLE.normalize('NFKC')
      const dirs: Array<{
        name: string
        folderToken: string
        batchId: string | null
        batchName: string | null
        sheetToken: string | null
        sheetUrl: string | null
        hasSheet: boolean
      }> = []

      for (const it of rootItems) {
        if (safeTrim(it.type) !== 'folder') continue
        const name = safeTrim(it.name).normalize('NFKC')
        const folderToken = safeTrim(it.token)
        if (!name || !folderToken) continue
        if (name === META_DIR.normalize('NFKC')) continue

        const children = await listAllInFolder(accessToken, folderToken)
        let sheetToken: string | null = null
        for (const child of children) {
          const t = safeTrim(child.type)
          if (t !== 'sheet' && t !== 'file') continue
          const n = safeTrim(child.name).normalize('NFKC')
          if (n === wantSheet && child.token) {
            sheetToken = safeTrim(child.token)
            break
          }
        }
        const batch = batchByDir.get(safePathSegment(name).normalize('NFKC')) ?? null
        dirs.push({
          name,
          folderToken,
          batchId: batch?.id ?? null,
          batchName: batch?.name ?? null,
          sheetToken,
          sheetUrl: sheetToken ? buildFeishuSheetWebUrl(sheetToken, webBaseUrl) : null,
          hasSheet: Boolean(sheetToken),
        })
      }

      dirs.sort((a, b) => a.name.localeCompare(b.name, 'zh'))
      return jsonResponse({
        ok: true,
        productId,
        productName: product.name,
        sheetTitle: VERSION_PACKAGE_SHEET_TITLE,
        webBaseUrl: webBaseUrl || undefined,
        dirs,
      })
    } catch (e) {
      return jsonResponse({
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      }, 200)
    }
  }

  if (action !== 'get') {
    return jsonResponse({ ok: false, error: `未知 action：${action}（支持 get / refresh / list_dirs）` }, 400)
  }

  try {
    const accessToken = await feishuTenantToken(appId, appSecret)
    const rootItems = await listAllInFolder(accessToken, rootFolder)
    const metaToken = findChildFolderToken(rootItems, META_DIR)
    if (!metaToken) {
      return jsonResponse({
        ok: true,
        productId,
        productName: product.name,
        exists: false,
        version: 1,
        updated_at: null,
        entries: [],
        message: '尚未创建 meta/package-manifest.json（可执行扫描刷新）',
      })
    }
    const metaItems = await listAllInFolder(accessToken, metaToken)
    const want = MANIFEST_FILE_NAME.normalize('NFKC')
    let fileToken: string | null = null
    for (const it of metaItems) {
      if (safeTrim(it.type) !== 'file') continue
      const n = safeTrim(it.name).normalize('NFKC')
      if (n === want && it.token) {
        fileToken = safeTrim(it.token)
        break
      }
    }
    if (!fileToken) {
      return jsonResponse({
        ok: true,
        productId,
        productName: product.name,
        exists: false,
        version: 1,
        updated_at: null,
        entries: [],
        message: 'meta 目录存在但未找到 package-manifest.json',
      })
    }
    const text = await downloadFileText(accessToken, fileToken)
    const manifest = normalizeManifestJson(text, webBaseUrl)
    return jsonResponse({
      ok: true,
      productId,
      productName: product.name,
      exists: true,
      version: manifest.version,
      updated_at: manifest.updated_at,
      entries: manifest.entries,
      entryCount: manifest.entries.length,
      manifestFileToken: fileToken,
      webBaseUrl: webBaseUrl || undefined,
    })
  } catch (e) {
    return jsonResponse({
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    }, 200)
  }
})
