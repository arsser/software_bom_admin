import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

type BomJsonKeyMap = {
  downloadUrl?: string[]
  groupSegment?: string[]
}

type FeishuListFile = {
  name?: string
  token?: string
  type?: string
  parent_token?: string
  shortcut_info?: { target_token?: string; target_type?: string }
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

function safeFlatFilename(name: string): string {
  const base = name && String(name).trim() ? String(name).trim() : 'artifact.bin'
  const cleaned = base.replace(/[/\\?*:|"<>]/g, '_').replace(/\s+/g, ' ')
  return cleaned.slice(0, 220) || 'artifact.bin'
}

function firstNonEmptyByKeys(obj: Record<string, unknown> | null | undefined, keys: string[]): string | null {
  if (!obj) return null
  for (const k of keys) {
    if (!k) continue
    if (!Object.prototype.hasOwnProperty.call(obj, k)) continue
    const v = safeTrim(obj[k])
    if (v) return v
  }
  return null
}

function normalizeBomKeyForMatch(s: string): string {
  return String(s)
    .normalize('NFKC')
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .trim()
    .toLowerCase()
}

function firstNonEmptyByKeysRelaxed(obj: Record<string, unknown> | null | undefined, keys: string[]): string | null {
  const exact = firstNonEmptyByKeys(obj, keys)
  if (exact) return exact
  if (!obj) return null
  const want = new Set(keys.map((k) => normalizeBomKeyForMatch(k)).filter(Boolean))
  for (const [k, val] of Object.entries(obj)) {
    if (want.has(normalizeBomKeyForMatch(k))) {
      const v = safeTrim(val)
      if (v) return v
    }
  }
  for (const [k, val] of Object.entries(obj)) {
    if (/分组/.test(String(k))) {
      const v = safeTrim(val)
      if (v) return v
    }
  }
  return null
}

function mergeKeyMap(raw: unknown): BomJsonKeyMap {
  const jm = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const arr = (k: keyof BomJsonKeyMap, def: string[]) => {
    const v = jm[k as string]
    return Array.isArray(v) && v.length && v.every((x) => typeof x === 'string') ? (v as string[]) : def
  }
  return {
    downloadUrl: arr('downloadUrl', ['下载路径', 'url', 'download_url', '下载地址']),
    groupSegment: arr('groupSegment', ['分组', 'group', 'groupName', '组别']),
  }
}

type FileHit = { token: string; name: string }

/** 相对「版本文件夹」的路径键：无分组为 fileName；有分组为 group/fileName */
function expectedRelKey(groupDir: string | null, fileName: string): string {
  return groupDir ? `${groupDir}/${fileName}` : fileName
}

async function feishuTenantToken(appId: string, appSecret: string): Promise<string> {
  const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  })
  const text = await res.text()
  let body: { code?: number; msg?: string; tenant_access_token?: string }
  try {
    body = JSON.parse(text) as typeof body
  } catch {
    throw new Error(`飞书 token 响应非 JSON：${text.slice(0, 200)}`)
  }
  if (!res.ok || body.code !== 0 || !body.tenant_access_token) {
    throw new Error(body.msg || `获取 tenant_access_token 失败 HTTP ${res.status}`)
  }
  return body.tenant_access_token
}

async function listFolderPage(
  accessToken: string,
  folderToken: string,
  pageToken?: string,
): Promise<{ files: FeishuListFile[]; has_more?: boolean; page_token?: string }> {
  const u = new URL('https://open.feishu.cn/open-apis/drive/v1/files')
  u.searchParams.set('folder_token', folderToken)
  u.searchParams.set('page_size', '200')
  if (pageToken) u.searchParams.set('page_token', pageToken)
  const res = await fetch(u.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  const text = await res.text()
  let body: { code?: number; msg?: string; data?: { files?: FeishuListFile[]; has_more?: boolean; next_page_token?: string } }
  try {
    body = JSON.parse(text) as typeof body
  } catch {
    throw new Error(`列出文件夹响应非 JSON：${text.slice(0, 200)}`)
  }
  if (!res.ok || body.code !== 0) {
    throw new Error(body.msg || `列出文件夹失败 HTTP ${res.status}`)
  }
  const files = Array.isArray(body.data?.files) ? body.data!.files! : []
  return {
    files,
    has_more: body.data?.has_more,
    page_token: body.data?.next_page_token,
  }
}

async function listAllInFolder(accessToken: string, folderToken: string): Promise<FeishuListFile[]> {
  const out: FeishuListFile[] = []
  let pageToken: string | undefined
  do {
    const page = await listFolderPage(accessToken, folderToken, pageToken)
    out.push(...page.files)
    pageToken = page.has_more && page.page_token ? page.page_token : undefined
  } while (pageToken)
  return out
}

function resolveFileToken(it: FeishuListFile): string | null {
  const t = safeTrim(it.type)
  if (t === 'file') return safeTrim(it.token) || null
  if (t === 'shortcut') {
    const tt = safeTrim(it.shortcut_info?.target_type)
    const tok = safeTrim(it.shortcut_info?.target_token)
    if (tt === 'file' && tok) return tok
  }
  return null
}

/**
 * 在「版本目录」下收集所有「文件」的相对路径 -> token（DFS，仅当前层 list + 递归子文件夹）
 */
async function buildFileIndexUnder(
  accessToken: string,
  folderToken: string,
  prefix: string,
  index: Map<string, FileHit>,
): Promise<void> {
  const items = await listAllInFolder(accessToken, folderToken)
  for (const it of items) {
    const name = safeTrim(it.name)
    if (!name) continue
    const t = safeTrim(it.type)
    const rel = prefix ? `${prefix}${name}` : name
    if (t === 'folder') {
      const childToken = safeTrim(it.token)
      if (!childToken) continue
      await buildFileIndexUnder(accessToken, childToken, `${rel}/`, index)
      continue
    }
    const fileTok = resolveFileToken(it)
    if (fileTok) {
      index.set(rel, { token: fileTok, name })
    }
  }
}

function findChildFolderToken(items: FeishuListFile[], folderName: string): string | null {
  for (const it of items) {
    if (safeTrim(it.type) !== 'folder') continue
    if (safeTrim(it.name) === folderName) {
      const tok = safeTrim(it.token)
      if (tok) return tok
    }
  }
  return null
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
    }, 500)
  }

  let batchId: string
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

  const { data: batch, error: batchErr } = await userClient
    .from('bom_batches')
    .select('id,name')
    .eq('id', batchId)
    .maybeSingle()

  if (batchErr || !batch) {
    return jsonResponse({ ok: false, error: batchErr?.message || '无权限或批次不存在' }, 403)
  }

  const { data: scannerRow, error: scannerErr } = await userClient
    .from('system_settings')
    .select('value')
    .eq('key', 'bom_scanner')
    .maybeSingle()

  if (scannerErr) {
    return jsonResponse({ ok: false, error: `读取 bom_scanner 失败：${scannerErr.message}` }, 500)
  }

  const scannerVal = (scannerRow?.value ?? {}) as Record<string, unknown>
  const rootFolder = safeTrim(scannerVal.feishuDriveRootFolderToken)
  if (!rootFolder) {
    return jsonResponse({ ok: false, error: '未配置飞书存储根目录 folder_token（系统设置 → BOM 本地扫描 → 飞书云盘根目录）' }, 400)
  }

  const keyMap = mergeKeyMap(scannerVal.jsonKeyMap)

  const { data: rows, error: rowsErr } = await userClient
    .from('bom_rows')
    .select('id,bom_row,status')
    .eq('batch_id', batchId)
    .order('sort_order', { ascending: true })

  if (rowsErr) {
    return jsonResponse({ ok: false, error: rowsErr.message }, 500)
  }

  const rowList = rows ?? []
  const batchNameRaw = safeTrim(batch.name)
  const batchNameFallback = `batch-${batchId.replace(/-/g, '').slice(0, 8)}`
  const batchDir = safePathSegment(batchNameRaw || batchNameFallback)

  const { data: jobIns, error: jobInsErr } = await userClient
    .from('bom_feishu_scan_jobs')
    .insert({
      batch_id: batchId,
      status: 'running',
      trigger_source: 'edge',
      message: null,
      rows_total: rowList.length,
      rows_present: 0,
      rows_absent: 0,
      rows_error: 0,
      started_at: new Date().toISOString(),
    })
    .select('id')
    .single()

  if (jobInsErr || !jobIns?.id) {
    return jsonResponse({ ok: false, error: jobInsErr?.message || '无法创建扫描任务' }, 500)
  }

  const jobId = jobIns.id as string

  let rowsPresent = 0
  let rowsAbsent = 0
  let rowsError = 0
  let lastMessage = ''

  try {
    const accessToken = await feishuTenantToken(appId, appSecret)
    const rootItems = await listAllInFolder(accessToken, rootFolder)
    const batchFolderToken = findChildFolderToken(rootItems, batchDir)
    if (!batchFolderToken) {
      lastMessage = `飞书根目录下未找到版本文件夹「${batchDir}」`
      for (const r of rowList) {
        const prev = (r.status && typeof r.status === 'object' ? r.status : {}) as Record<string, unknown>
        const next = {
          ...prev,
          feishu: 'absent',
          feishu_scanned_at: new Date().toISOString(),
          feishu_scan_error: lastMessage,
        }
        const { error: uerr } = await userClient.from('bom_rows').update({ status: next }).eq('id', r.id)
        if (uerr) rowsError += 1
        else rowsAbsent += 1
      }
    } else {
      const index = new Map<string, FileHit>()
      await buildFileIndexUnder(accessToken, batchFolderToken, '', index)

      for (const r of rowList) {
        const bomRow = (r.bom_row && typeof r.bom_row === 'object' ? r.bom_row : {}) as Record<string, unknown>
        const prev = (r.status && typeof r.status === 'object' ? r.status : {}) as Record<string, unknown>

        const { data: dlRaw, error: rpcErr } = await userClient.rpc('bom_extract_download_url', {
          p_row: bomRow,
        })
        if (rpcErr) {
          rowsError += 1
          const next = {
            ...prev,
            feishu: 'error',
            feishu_scanned_at: new Date().toISOString(),
            feishu_scan_error: `提取下载路径失败：${rpcErr.message}`,
          }
          await userClient.from('bom_rows').update({ status: next }).eq('id', r.id)
          continue
        }

        const dl = typeof dlRaw === 'string' ? dlRaw.trim() : ''
        if (!dl) {
          rowsError += 1
          const next = {
            ...prev,
            feishu: 'error',
            feishu_scanned_at: new Date().toISOString(),
            feishu_scan_error: 'BOM 行缺少下载路径，无法推导飞书文件名',
          }
          await userClient.from('bom_rows').update({ status: next }).eq('id', r.id)
          continue
        }

        const { data: baseNameRaw, error: bnErr } = await userClient.rpc('bom_url_path_basename', { p: dl })
        if (bnErr || typeof baseNameRaw !== 'string' || !String(baseNameRaw).trim()) {
          rowsError += 1
          const next = {
            ...prev,
            feishu: 'error',
            feishu_scanned_at: new Date().toISOString(),
            feishu_scan_error: bnErr?.message || '无法从下载路径解析文件名',
          }
          await userClient.from('bom_rows').update({ status: next }).eq('id', r.id)
          continue
        }

        const fileName = safeFlatFilename(String(baseNameRaw))
        const groupRaw = firstNonEmptyByKeysRelaxed(bomRow, keyMap.groupSegment ?? [])
        const groupDir = groupRaw ? safePathSegment(groupRaw) : null
        const relKey = expectedRelKey(groupDir, fileName)
        const hit = index.get(relKey)

        const iso = new Date().toISOString()
        if (hit) {
          rowsPresent += 1
          const next = {
            ...prev,
            feishu: 'present',
            feishu_file_token: hit.token,
            feishu_file_name: hit.name,
            feishu_scanned_at: iso,
          }
          delete (next as Record<string, unknown>).feishu_scan_error
          await userClient.from('bom_rows').update({ status: next }).eq('id', r.id)
        } else {
          rowsAbsent += 1
          const next = {
            ...prev,
            feishu: 'absent',
            feishu_scanned_at: iso,
            feishu_scan_error: null,
          }
          delete (next as Record<string, unknown>).feishu_file_token
          delete (next as Record<string, unknown>).feishu_file_name
          await userClient.from('bom_rows').update({ status: next }).eq('id', r.id)
        }
      }

      lastMessage =
        rowsError > 0
          ? `完成：存在 ${rowsPresent}，缺失 ${rowsAbsent}，解析/API 错误 ${rowsError}`
          : `完成：存在 ${rowsPresent}，缺失 ${rowsAbsent}`
    }

    await userClient
      .from('bom_feishu_scan_jobs')
      .update({
        status: 'succeeded',
        finished_at: new Date().toISOString(),
        rows_present: rowsPresent,
        rows_absent: rowsAbsent,
        rows_error: rowsError,
        message: lastMessage,
      })
      .eq('id', jobId)

    return jsonResponse({
      ok: true,
      jobId,
      batchId,
      rows_total: rowList.length,
      rows_present: rowsPresent,
      rows_absent: rowsAbsent,
      rows_error: rowsError,
      message: lastMessage,
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await userClient
      .from('bom_feishu_scan_jobs')
      .update({
        status: 'failed',
        finished_at: new Date().toISOString(),
        rows_present: rowsPresent,
        rows_absent: rowsAbsent,
        rows_error: rowsError,
        message: msg.slice(0, 2000),
      })
      .eq('id', jobId)

    return jsonResponse({ ok: false, jobId, error: msg }, 200)
  }
})
