import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

type BomJsonKeyMap = {
  downloadUrl?: string[]
  expectedMd5?: string[]
    /** 与 bom_scanner 一致；中间目录与 ext 同步：优先「组件」列，否则「分组」列 */
  moduleName?: string[]
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
    expectedMd5: arr('expectedMd5', ['MD5', 'md5', 'checksum']),
    moduleName: arr('moduleName', ['模块', 'module', '组件', 'moduleName']),
    groupSegment: arr('groupSegment', ['分组', 'group', 'groupName', '组别']),
  }
}

type FileHit = { token: string; name: string }

/** 相对「版本文件夹」的路径键：无中间目录为 fileName；否则为 {组件或分组}/fileName（与 ext 目标路径一致） */
function expectedRelKey(middleDir: string | null, fileName: string): string {
  return middleDir ? `${middleDir}/${fileName}` : fileName
}

function basenameFromStoragePath(p: string): string {
  const t = String(p ?? '').trim().replace(/\\/g, '/')
  const parts = t.split('/').filter(Boolean)
  return parts.length ? parts[parts.length - 1]! : ''
}

/** 与 ext 同步脚本一致：优先 jsonKeyMap.moduleName（组件），否则 groupSegment（分组） */
function resolveMiddleDirFromRow(bomRow: Record<string, unknown>, keyMap: BomJsonKeyMap): string | null {
  const mod = firstNonEmptyByKeysRelaxed(bomRow, keyMap.moduleName ?? [])
  if (mod) return safePathSegment(mod)
  const grp = firstNonEmptyByKeysRelaxed(bomRow, keyMap.groupSegment ?? [])
  if (grp) return safePathSegment(grp)
  return null
}

function extractExpectedMd5Lower(bomRow: Record<string, unknown>, keyMap: BomJsonKeyMap): string | null {
  const v = firstNonEmptyByKeysRelaxed(bomRow, keyMap.expectedMd5 ?? [])
  if (!v) return null
  const lower = v.trim().toLowerCase()
  return /^[a-f0-9]{32}$/.test(lower) ? lower : null
}

/** 飞书云空间二进制文件：尝试 HEAD Content-Length，再尝试 Range 首字节解析总大小 */
async function fetchDriveBinaryFileSize(accessToken: string, fileToken: string): Promise<number | null> {
  const url = `https://open.feishu.cn/open-apis/drive/v1/files/${encodeURIComponent(fileToken)}/download`
  try {
    const headRes = await fetch(url, {
      method: 'HEAD',
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (headRes.ok) {
      const cl = headRes.headers.get('content-length')
      if (cl) {
        const n = parseInt(cl, 10)
        if (Number.isFinite(n) && n > 0) return n
      }
    }
  } catch {
    // ignore
  }
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Range: 'bytes=0-0',
      },
    })
    const cr = res.headers.get('content-range')
    if (cr) {
      const m = cr.match(/\/(\d+)\s*$/)
      if (m) {
        const n = Number(m[1])
        if (Number.isFinite(n) && n >= 0) return n
      }
    }
    if (res.ok) {
      const cl = res.headers.get('content-length')
      if (cl) {
        const n = parseInt(cl, 10)
        if (Number.isFinite(n) && n > 0) return n
      }
    }
  } catch {
    // ignore
  }
  return null
}

async function fetchSizesForFileTokens(
  accessToken: string,
  tokens: string[],
  concurrency: number,
): Promise<Map<string, number>> {
  const uniq = [...new Set(tokens.map((t) => safeTrim(t)).filter(Boolean))]
  const out = new Map<string, number>()
  let idx = 0
  const workers = Math.min(Math.max(1, concurrency), uniq.length || 1)
  const run = async () => {
    for (;;) {
      const i = idx++
      if (i >= uniq.length) return
      const tok = uniq[i]!
      const sz = await fetchDriveBinaryFileSize(accessToken, tok)
      if (sz != null) out.set(tok, sz)
    }
  }
  await Promise.all(new Array(workers).fill(0).map(() => run()))
  return out
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

/** 在父 folder_token 下创建子文件夹（POST drive/v1/files/create_folder） */
async function createDriveChildFolder(
  accessToken: string,
  parentFolderToken: string,
  name: string,
): Promise<{ token: string }> {
  const res = await fetch('https://open.feishu.cn/open-apis/drive/v1/files/create_folder', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({ folder_token: parentFolderToken, name }),
  })
  const text = await res.text()
  let parsed: { code?: number; msg?: string; log_id?: string; data?: { token?: string } }
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
  return { token: token.trim() }
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

  /** 已通过 userClient 校验批次访问权；后续写库与读全局配置改用 service_role，避免 RLS / anon 读不到 system_settings、写不进 bom_feishu_scan_jobs 等导致 500 */
  if (!supabaseServiceKey) {
    return jsonResponse({ ok: false, error: 'Edge 缺少 SUPABASE_SERVICE_ROLE_KEY' }, 500)
  }
  const svc = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const { data: scannerRow, error: scannerErr } = await svc
    .from('system_settings')
    .select('value')
    .eq('key', 'bom_scanner')
    .maybeSingle()

  if (scannerErr) {
    return jsonResponse({ ok: false, error: `读取 bom_scanner 失败：${scannerErr.message}` }, 500)
  }

  const scannerVal = (scannerRow?.value ?? {}) as Record<string, unknown>
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

  const keyMap = mergeKeyMap(scannerVal.jsonKeyMap)

  const { data: rows, error: rowsErr } = await svc
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

  const { data: jobIns, error: jobInsErr } = await svc
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
    if (jobInsErr) console.error('[bom-feishu-scan] bom_feishu_scan_jobs insert:', jobInsErr.code, jobInsErr.message, jobInsErr)
    return jsonResponse({ ok: false, error: jobInsErr?.message || '无法创建扫描任务' }, 500)
  }

  const jobId = jobIns.id as string
  console.info(
    '[bom-feishu-scan] job',
    jobId,
    'batch',
    batchId,
    'rows',
    rowList.length,
    'autoCreateVersionFolder',
    autoCreateVersionFolder,
  )

  let rowsPresent = 0
  let rowsAbsent = 0
  let rowsError = 0
  let lastMessage = ''
  /** 与 rowsError 对应，用于汇总 message，便于前端弹窗区分原因 */
  let errDbOnAbsent = 0
  let errLfQuery = 0
  let errRowNoMd5 = 0
  let errRowNoLocal = 0
  let errFeishuSize = 0
  let errBatchNoMd5Rows = 0

  try {
    const accessToken = await feishuTenantToken(appId, appSecret)
    const rootItems = await listAllInFolder(accessToken, rootFolder)
    let batchFolderToken = findChildFolderToken(rootItems, batchDir)
    if (batchFolderToken) {
      console.info('[bom-feishu-scan] job', jobId, 'version folder at root (existing):', batchDir)
    } else if (autoCreateVersionFolder) {
      console.info('[bom-feishu-scan] job', jobId, 'version folder missing, create_folder:', batchDir)
      try {
        const created = await createDriveChildFolder(accessToken, rootFolder, batchDir)
        batchFolderToken = created.token
        console.info('[bom-feishu-scan] job', jobId, 'create_folder succeeded:', batchDir)
      } catch (createErr) {
        const createMsg = createErr instanceof Error ? createErr.message : String(createErr)
        console.warn('[bom-feishu-scan] job', jobId, 'create_folder failed:', createMsg, 'relisting root…')
        const refreshed = await listAllInFolder(accessToken, rootFolder)
        batchFolderToken = findChildFolderToken(refreshed, batchDir)
        if (!batchFolderToken) {
          throw createErr instanceof Error ? createErr : new Error(String(createErr))
        }
        console.info('[bom-feishu-scan] job', jobId, 'version folder after relist (reuse existing):', batchDir)
      }
    } else {
      console.info('[bom-feishu-scan] job', jobId, 'version folder missing, autoCreate off:', batchDir)
    }
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
        const { error: uerr } = await svc.from('bom_rows').update({ status: next }).eq('id', r.id)
        if (uerr) {
          rowsError += 1
          errDbOnAbsent += 1
        } else rowsAbsent += 1
      }
    } else {
      const index = new Map<string, FileHit>()
      await buildFileIndexUnder(accessToken, batchFolderToken, '', index)

      const md5Needed = new Set<string>()
      for (const r of rowList) {
        const bomRow = (r.bom_row && typeof r.bom_row === 'object' ? r.bom_row : {}) as Record<string, unknown>
        const m = extractExpectedMd5Lower(bomRow, keyMap)
        if (m) md5Needed.add(m)
      }
      const md5Arr = [...md5Needed]
      const localByMd5 = new Map<string, { path: string; sizeBytes: number }>()
      if (md5Arr.length > 0) {
        const { data: lfRows, error: lfErr } = await svc
          .from('local_file')
          .select('md5,path,size_bytes')
          .in('md5', md5Arr)
        if (lfErr) {
          lastMessage = `读取本地索引失败：${lfErr.message}`
          for (const r of rowList) {
            const prev = (r.status && typeof r.status === 'object' ? r.status : {}) as Record<string, unknown>
            const next = {
              ...prev,
              feishu: 'error',
              feishu_scanned_at: new Date().toISOString(),
              feishu_scan_error: lastMessage,
            }
            const { error: uerr } = await svc.from('bom_rows').update({ status: next }).eq('id', r.id)
            if (!uerr) {
              rowsError += 1
              errLfQuery += 1
            }
          }
        } else {
          for (const row of lfRows ?? []) {
            const rec = row as { md5?: string; path?: string; size_bytes?: number | string }
            const m = String(rec.md5 ?? '').trim().toLowerCase()
            const p = String(rec.path ?? '').trim()
            const szRaw = rec.size_bytes
            const sz = typeof szRaw === 'string' ? Number(szRaw) : Number(szRaw)
            if (/^[a-f0-9]{32}$/.test(m) && p && Number.isFinite(sz) && sz >= 0 && !localByMd5.has(m)) {
              localByMd5.set(m, { path: p, sizeBytes: Math.trunc(sz) })
            }
          }

          const tokensForSize = [...index.values()].map((h) => h.token).filter(Boolean)
          const sizeByToken = await fetchSizesForFileTokens(accessToken, tokensForSize, 10)

          for (const r of rowList) {
            const bomRow = (r.bom_row && typeof r.bom_row === 'object' ? r.bom_row : {}) as Record<string, unknown>
            const prev = (r.status && typeof r.status === 'object' ? r.status : {}) as Record<string, unknown>
            const iso = new Date().toISOString()

            const md5Lower = extractExpectedMd5Lower(bomRow, keyMap)
            if (!md5Lower) {
              rowsError += 1
              errRowNoMd5 += 1
              const next = {
                ...prev,
                feishu: 'error',
                feishu_scanned_at: iso,
                feishu_scan_error: 'BOM 行缺少合法期望 MD5，无法与本地索引对账',
              }
              delete (next as Record<string, unknown>).feishu_file_token
              delete (next as Record<string, unknown>).feishu_file_name
              delete (next as Record<string, unknown>).feishu_size_bytes
              await svc.from('bom_rows').update({ status: next }).eq('id', r.id)
              continue
            }

            const localHit = localByMd5.get(md5Lower)
            if (!localHit) {
              rowsError += 1
              errRowNoLocal += 1
              const next = {
                ...prev,
                feishu: 'error',
                feishu_scanned_at: iso,
                feishu_scan_error: '本地索引中无该 MD5，请先完成本地扫描后再对账飞书',
              }
              delete (next as Record<string, unknown>).feishu_file_token
              delete (next as Record<string, unknown>).feishu_file_name
              delete (next as Record<string, unknown>).feishu_size_bytes
              await svc.from('bom_rows').update({ status: next }).eq('id', r.id)
              continue
            }

            const localBaseName = safeFlatFilename(basenameFromStoragePath(localHit.path))
            const middleDir = resolveMiddleDirFromRow(bomRow, keyMap)
            const relKey = expectedRelKey(middleDir, localBaseName)
            const hit = index.get(relKey)

            if (!hit) {
              rowsAbsent += 1
              const next = {
                ...prev,
                feishu: 'absent',
                feishu_scanned_at: iso,
                feishu_scan_error: `飞书未找到路径「${relKey}」（与外部 AF：版本目录/组件或分组/本地文件名）`,
              }
              delete (next as Record<string, unknown>).feishu_file_token
              delete (next as Record<string, unknown>).feishu_file_name
              delete (next as Record<string, unknown>).feishu_size_bytes
              await svc.from('bom_rows').update({ status: next }).eq('id', r.id)
              continue
            }

            const feishuSz = sizeByToken.get(hit.token) ?? null
            const feishuNameNorm = safeFlatFilename(hit.name).normalize('NFKC')
            const localNameNorm = localBaseName.normalize('NFKC')
            const nameOk = feishuNameNorm === localNameNorm
            const locSz = Number(localHit.sizeBytes)
            const sizeOk = feishuSz != null && Number.isFinite(locSz) && feishuSz === locSz

            if (!nameOk) {
              rowsAbsent += 1
              const next = {
                ...prev,
                feishu: 'absent',
                feishu_scanned_at: iso,
                feishu_file_token: hit.token,
                feishu_file_name: hit.name,
                feishu_size_bytes: feishuSz ?? undefined,
                feishu_scan_error: `文件名不一致：本地「${localBaseName}」，飞书「${hit.name}」`,
              }
              await svc.from('bom_rows').update({ status: next }).eq('id', r.id)
              continue
            }

            if (feishuSz == null) {
              rowsError += 1
              errFeishuSize += 1
              const next = {
                ...prev,
                feishu: 'error',
                feishu_scanned_at: iso,
                feishu_file_token: hit.token,
                feishu_file_name: hit.name,
                feishu_scan_error: '无法读取飞书文件字节数（HEAD/Range），请检查应用云文档下载权限',
              }
              delete (next as Record<string, unknown>).feishu_size_bytes
              await svc.from('bom_rows').update({ status: next }).eq('id', r.id)
              continue
            }

            if (!sizeOk) {
              rowsAbsent += 1
              const next = {
                ...prev,
                feishu: 'absent',
                feishu_scanned_at: iso,
                feishu_file_token: hit.token,
                feishu_file_name: hit.name,
                feishu_size_bytes: feishuSz,
                feishu_scan_error: `字节数不一致：本地 ${localHit.sizeBytes}，飞书 ${feishuSz}`,
              }
              await svc.from('bom_rows').update({ status: next }).eq('id', r.id)
              continue
            }

            rowsPresent += 1
            const next = {
              ...prev,
              feishu: 'present',
              feishu_file_token: hit.token,
              feishu_file_name: hit.name,
              feishu_size_bytes: feishuSz,
              feishu_scanned_at: iso,
            }
            delete (next as Record<string, unknown>).feishu_scan_error
            await svc.from('bom_rows').update({ status: next }).eq('id', r.id)
          }

          const errParts: string[] = []
          if (errRowNoMd5) errParts.push(`缺期望 MD5 ${errRowNoMd5} 行`)
          if (errRowNoLocal) errParts.push(`本地索引无该 MD5 ${errRowNoLocal} 行（需先做 BOM 本地扫描）`)
          if (errFeishuSize) errParts.push(`无法读飞书文件大小 ${errFeishuSize} 行（权限或接口）`)
          if (errLfQuery) errParts.push(`读 local_file 失败 ${errLfQuery} 行`)
          if (errDbOnAbsent) errParts.push(`写库失败 ${errDbOnAbsent} 行`)
          const errDetail = errParts.length > 0 ? ` ${errParts.join('；')}` : ''
          lastMessage =
            rowsError > 0
              ? `完成：与飞书完全一致 ${rowsPresent}，需上传或不一致 ${rowsAbsent}，无法对账 ${rowsError} 行（非崩溃；多为缺 MD5 / 未扫本地 / 读飞书大小失败）。${errDetail}`.trim()
              : `完成：与飞书完全一致 ${rowsPresent}，需上传或不一致 ${rowsAbsent}`
        }
      } else {
        const noMd5Msg = '该版本无有效 MD5 行，无法与飞书对账（请先在 BOM 中配置并保存清单 MD5）'
        lastMessage = noMd5Msg
        const iso = new Date().toISOString()
        for (const r of rowList) {
          const prev = (r.status && typeof r.status === 'object' ? r.status : {}) as Record<string, unknown>
          const next = {
            ...prev,
            feishu: 'error',
            feishu_scanned_at: iso,
            feishu_scan_error: noMd5Msg,
          }
          delete (next as Record<string, unknown>).feishu_file_token
          delete (next as Record<string, unknown>).feishu_file_name
          delete (next as Record<string, unknown>).feishu_size_bytes
          const { error: uerr } = await svc.from('bom_rows').update({ status: next }).eq('id', r.id)
          if (!uerr) {
            rowsError += 1
            errBatchNoMd5Rows += 1
          }
        }
        if (errBatchNoMd5Rows > 0) {
          lastMessage = `${noMd5Msg}（已标记 ${errBatchNoMd5Rows} 行）`
        }
      }
    }

    await svc
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
    console.error('[bom-feishu-scan] try/catch:', msg)
    if (e instanceof Error && e.stack) console.error(e.stack)
    await svc
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
