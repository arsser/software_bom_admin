import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

type EdgeResult =
  | {
      ok: true
      needPut: true
      message?: string
    }
  | {
      ok: true
      needPut: false
      ext_url: string
      ext_sync_kind: 'copied' | 'uploaded'
      targetRel: string
      copiedFrom?: { repo: string; path: string }
    }
  | {
      ok: false
      error: string
      status?: number
    }

function normalizeBaseUrl(url?: string | null): string {
  let u = String(url ?? '').trim()
  if (!u) return ''
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`
  u = u.replace(/\/+$/, '')
  // worker 约定：必须最终以 /artifactory 结尾
  if (!/\/artifactory$/i.test(u)) u = `${u}/artifactory`
  return u
}

function safeTrim(s: unknown): string {
  return String(s ?? '').trim()
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

/** 列名可能与 jsonKeyMap 不完全一致（空格/零宽/全角）；再匹配列名含「分组」的列 */
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

function isValidMd5Hex(s: string): boolean {
  return /^[a-f0-9]{32}$/i.test(s.trim())
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

function parseArtifactoryStorageUri(storageUri: string | null | undefined): { repo: string; path: string } | null {
  const s = safeTrim(storageUri)
  const marker = '/artifactory/api/storage/'
  const i = s.indexOf(marker)
  if (i < 0) return null
  const rest = s.slice(i + marker.length).split('?')[0]
  const parts = rest.split('/').filter(Boolean)
  if (parts.length < 2) return null
  const repo = parts[0]
  const relPath = parts.slice(1).join('/')
  return { repo, path: relPath }
}

function getDownloadUrl(baseUrl: string, repo: string, relPath: string): string {
  const base = baseUrl.replace(/\/+$/, '')
  const rp = relPath.replace(/^\/+/, '')
  return `${base}/${repo}/${rp}`
}

const STORAGE_FETCH_MS = 15000

function toStorageApiUrl(rawUrl: string): string | null {
  try {
    const u = new URL(rawUrl)
    if (u.pathname.includes('/api/storage/')) return rawUrl
    const artifactoryPrefix = '/artifactory/'
    const pathIdx = u.pathname.indexOf(artifactoryPrefix)
    if (pathIdx === -1) {
      const path = u.pathname.startsWith('/') ? u.pathname : `/${u.pathname}`
      return `${u.origin}/artifactory/api/storage${path}`
    }
    const pathAfterPrefix = u.pathname.substring(pathIdx + artifactoryPrefix.length)
    return `${u.origin}${artifactoryPrefix}api/storage/${pathAfterPrefix}`
  } catch {
    return null
  }
}

async function fetchArtifactSizeFromStorageUrl(
  storageUrl: string,
  headers: Record<string, string>,
): Promise<number | null> {
  try {
    const controller = new AbortController()
    const t = setTimeout(() => controller.abort(), STORAGE_FETCH_MS)
    const res = await fetch(storageUrl, {
      method: 'GET',
      headers: { ...headers, Accept: 'application/json' },
      signal: controller.signal,
    })
    clearTimeout(t)
    if (!res.ok) return null
    const data = (await res.json()) as { size?: unknown }
    const n = data?.size != null ? Number(data.size) : NaN
    if (!Number.isFinite(n) || n < 0) return null
    return Math.round(n)
  } catch {
    return null
  }
}

async function readDbJsonValue(supabase: ReturnType<typeof createClient>, key: string): Promise<any> {
  const { data, error } = await supabase.from('system_settings').select('value').eq('key', key).maybeSingle()
  if (error) throw new Error(`read system_settings.${key} failed: ${error.message}`)
  return data?.value ?? {}
}

/** 展开 status JSONB，保留 local_fetch_error 等扩展键 */
function expandStatus(s: unknown): Record<string, unknown> {
  const raw = s && typeof s === 'object' && !Array.isArray(s) ? { ...(s as Record<string, unknown>) } : {}
  if (typeof raw.local !== 'string') raw.local = 'pending'
  if (typeof raw.ext !== 'string') raw.ext = 'not_started'
  return raw
}

/** 仅更新 status.ext 与 ext_fetch_error，不改动 local / local_fetch_error */
async function updateBomRowExtError(
  supabase: ReturnType<typeof createClient>,
  rowId: string,
  message: string,
  currentStatus: unknown,
) {
  const st = expandStatus(currentStatus)
  st.ext = 'error'
  st.ext_fetch_error = message.slice(0, 1000)
  await supabase.from('bom_rows').update({ status: st }).eq('id', rowId)
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST')
    return new Response(JSON.stringify({ ok: false, error: 'Method not allowed' }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })

  try {
    let body: { row_id?: string }
    try {
      body = await req.json()
    } catch {
      return new Response(JSON.stringify({ ok: false, error: 'Invalid JSON body' }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const rowId = safeTrim(body?.row_id)
    if (!rowId) {
      return new Response(JSON.stringify({ ok: false, error: 'Missing row_id' }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    if (!supabaseUrl || !serviceKey) throw new Error('Edge missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY')

    const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })

    // 1) 读 bom_row + batch name
    const { data: rowData, error: rowErr } = await admin
      .from('bom_rows')
      .select('id,batch_id,bom_row,status,bom_batches(name)')
      .eq('id', rowId)
      .maybeSingle()

    if (rowErr || !rowData) {
      return new Response(JSON.stringify({ ok: false, error: rowErr?.message ?? 'bom row not found' }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const bomRow = (rowData.bom_row ?? {}) as Record<string, unknown>
    const batchNameRaw = rowData?.bom_batches?.name ? safeTrim(rowData.bom_batches.name) : ''
    const batchNameFallback = `batch-${safeTrim(rowData.batch_id).replace(/-/g, '').slice(0, 8)}`
    const batchName = batchNameRaw || batchNameFallback

    // 2) 读 bom_scanner.jsonKeyMap（用于提 md5 与 ext_url 写回键名），以及 extArtifactoryRepo
    const bomScanner = await readDbJsonValue(admin, 'bom_scanner')
    const jsonKeyMap = bomScanner?.jsonKeyMap ?? {}
    const expectedMd5Keys: string[] = Array.isArray(jsonKeyMap.expectedMd5) ? jsonKeyMap.expectedMd5 : ['MD5', 'md5', 'checksum']
    const extUrlKeys: string[] = Array.isArray(jsonKeyMap.extUrl) && jsonKeyMap.extUrl.length
      ? jsonKeyMap.extUrl
      : ['ext_url', 'extUrl', '转存地址']
    const extFileSizeKeys: string[] = Array.isArray(jsonKeyMap.extFileSizeBytes) && jsonKeyMap.extFileSizeBytes.length
      ? jsonKeyMap.extFileSizeBytes
      : ['ext_size_bytes', 'ext文件大小', 'extSize', 'ext大小']

    const extRepo = safeTrim(bomScanner?.extArtifactoryRepo)
    if (!extRepo) {
      await updateBomRowExtError(
        admin,
        rowId,
        '未配置 ext 目标仓库：请在系统设置 → BOM 本地扫描填写 extArtifactoryRepo',
        rowData.status,
      )
      return new Response(JSON.stringify({ ok: false, error: 'Missing extArtifactoryRepo' }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const md5Raw = firstNonEmptyByKeys(bomRow, expectedMd5Keys)
    const md5Lower = md5Raw && isValidMd5Hex(md5Raw) ? md5Raw.trim().toLowerCase() : ''
    if (!md5Lower) {
      await updateBomRowExtError(admin, rowId, 'ext 查重失败：BOM 行缺少合法期望 MD5', rowData.status)
      return new Response(JSON.stringify({ ok: false, error: 'Missing/invalid expected MD5' }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // 3) 读 artifactory ext 凭据
    const artCfg = await readDbJsonValue(admin, 'artifactory_config')
    const extApiKey = safeTrim(artCfg?.artifactoryExtApiKey) || safeTrim(artCfg?.artifactoryApiKey)
    const extBaseUrl = normalizeBaseUrl(artCfg?.artifactoryExtBaseUrl) || normalizeBaseUrl(artCfg?.artifactoryBaseUrl)
    if (!extApiKey || !extBaseUrl) {
      await updateBomRowExtError(
        admin,
        rowId,
        '未配置外部 Artifactory：请配置 artifactory_config 的外部 Base URL / API Key',
        rowData.status,
      )
      return new Response(JSON.stringify({ ok: false, error: 'Missing ext Artifactory credentials' }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // 4) checksum search（限定 extRepo）
    const headers = {
      Authorization: `Bearer ${extApiKey}`,
      'X-JFrog-Art-Api': extApiKey,
      'X-Api-Key': extApiKey,
      Accept: 'application/json',
    }
    const checksumUrl = new URL('api/search/checksum', `${extBaseUrl}/`)
    checksumUrl.searchParams.set('md5', md5Lower)
    checksumUrl.searchParams.set('repos', extRepo)

    const checksumRes = await fetch(checksumUrl.toString(), { headers })
    const checksumText = await checksumRes.text()
    if (!checksumRes.ok) {
      const msg = `checksum search HTTP ${checksumRes.status}: ${checksumText.slice(0, 400)}`
      await updateBomRowExtError(admin, rowId, msg, rowData.status)
      return new Response(JSON.stringify({ ok: false, error: msg, status: checksumRes.status }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    let bodyObj: any = null
    try {
      bodyObj = JSON.parse(checksumText)
    } catch {
      await updateBomRowExtError(admin, rowId, 'checksum search: invalid JSON', rowData.status)
      return new Response(JSON.stringify({ ok: false, error: 'checksum search invalid JSON' }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const results: Array<{ uri?: string; downloadUri?: string }> = Array.isArray(bodyObj?.results) ? bodyObj.results : []
    const hits = results
      .map((r) => ({ uri: typeof r.uri === 'string' ? r.uri : '', downloadUri: typeof r.downloadUri === 'string' ? r.downloadUri : '' }))
      .filter((r) => r.uri)
    hits.sort((a, b) => a.uri.localeCompare(b.uri))
    const first = hits[0]

    if (!first) {
      // 命中不存在：ext 侧可能从未上传，也可能“曾存在但已被删除”
      // 如果本行已有 ext_url（历史写回），这里要把 ext_url 清掉并回退状态，避免 UI 误以为仍存在。
      const prevExt = firstNonEmptyByKeys(bomRow, extUrlKeys)
      const nextBom: Record<string, unknown> = { ...bomRow }
      for (const k of extUrlKeys) {
        if (!k) continue
        nextBom[k] = null
      }
      for (const k of extFileSizeKeys) {
        if (!k) continue
        nextBom[k] = null
      }
      delete (nextBom as any).ext_sync_kind

      const msg = prevExt
        ? 'ext 已删除或不存在，需本地下载并校验后再上传外部 Artifactory'
        : '外部 Artifactory 不存在，需拉取-校验后再上传'

      const stMiss = expandStatus(rowData.status)
      stMiss.ext = 'not_started'
      delete stMiss.ext_fetch_error
      const { error: missUpErr } = await admin
        .from('bom_rows')
        .update({
          bom_row: nextBom,
          status: stMiss,
        })
        .eq('id', rowId)
      if (missUpErr) {
        return new Response(JSON.stringify({ ok: false, error: `写回 bom_rows 失败: ${missUpErr.message}` } satisfies EdgeResult), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }

      return new Response(JSON.stringify({ ok: true, needPut: true, message: msg } satisfies EdgeResult), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const parsed = parseArtifactoryStorageUri(first.uri)
    if (!parsed) {
      const msg = '无法解析 checksum 命中的 storage URI'
      await updateBomRowExtError(admin, rowId, msg, rowData.status)
      return new Response(JSON.stringify({ ok: false, error: msg }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // 5) 计算目标路径（与你们简化后的阶段 5 规则一致）
    const moduleNameKeys: string[] = Array.isArray(jsonKeyMap.moduleName) && jsonKeyMap.moduleName.length
      ? jsonKeyMap.moduleName
      : ['模块', 'module', '组件', 'moduleName']
    const groupSegmentKeys: string[] = Array.isArray(jsonKeyMap.groupSegment) && jsonKeyMap.groupSegment.length
      ? jsonKeyMap.groupSegment
      : ['分组', 'group', 'groupName', '组别']
    const modRaw = firstNonEmptyByKeysRelaxed(bomRow, moduleNameKeys)
    const groupRaw = firstNonEmptyByKeysRelaxed(bomRow, groupSegmentKeys)
    const midDir = modRaw ? safePathSegment(modRaw) : groupRaw ? safePathSegment(groupRaw) : null

    const fileName = (() => {
      const p = parsed.path.replace(/\/+$/, '')
      const parts = p.split('/').filter(Boolean)
      const last = parts.length ? parts[parts.length - 1] : 'artifact.bin'
      return safeFlatFilename(last)
    })()

    const batchDir = safePathSegment(batchName)
    const targetRel = midDir ? [batchDir, midDir, fileName].join('/') : [batchDir, fileName].join('/')
    const targetDl = getDownloadUrl(extBaseUrl, extRepo, targetRel)

    // 6) Copy 到当前版本目录入口（无论原入口是否已存在都 Copy，保证版本树完整）
    const base = extBaseUrl.endsWith('/') ? extBaseUrl : `${extBaseUrl}/`
    const relFrom = `api/copy/${parsed.repo}/${parsed.path}`.replace(/\/+/g, '/').replace(/^\/+/, '')
    const copyUrl = new URL(relFrom, base)
    copyUrl.searchParams.set('to', `${extRepo}/${targetRel}`)

    const copyRes = await fetch(copyUrl.toString(), {
      method: 'POST',
      headers: { ...headers, Accept: 'application/json' },
    })
    const copyText = await copyRes.text()
    if (!copyRes.ok) {
      // 幂等：当命中源路径与目标路径相同，Artifactory 会返回 409 "Destination and source are the same"
      // 此时视为成功（版本目录入口已满足），继续写回 ext_url。
      const samePath =
        copyRes.status === 409 && /Destination and source are the same/i.test(copyText)
      if (!samePath) {
        const msg = `copy HTTP ${copyRes.status}: ${copyText.slice(0, 500)}`
        await updateBomRowExtError(admin, rowId, msg, rowData.status)
        return new Response(JSON.stringify({ ok: false, error: msg, status: copyRes.status }), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }
    }

    // 7) 写回 bom_row（只写 jsonb 的 ext_url 等别名键）
    const nextBom: Record<string, unknown> = { ...bomRow }
    for (const k of extUrlKeys) {
      if (!k) continue
      nextBom[k] = targetDl
    }
    nextBom.ext_sync_kind = 'copied'

    const storageUrl = toStorageApiUrl(targetDl)
    if (storageUrl) {
      const extSz = await fetchArtifactSizeFromStorageUrl(storageUrl, headers)
      if (extSz != null) {
        for (const k of extFileSizeKeys) {
          if (!k) continue
          nextBom[k] = String(extSz)
        }
      }
    }

    const stOk = expandStatus(rowData.status)
    stOk.ext = 'synced_or_skipped'
    delete stOk.ext_fetch_error
    const { error: upErr } = await admin
      .from('bom_rows')
      .update({
        bom_row: nextBom,
        status: stOk,
      })
      .eq('id', rowId)

    if (upErr) {
      const msg = `写回 bom_rows 失败: ${upErr.message}`
      await updateBomRowExtError(admin, rowId, msg, rowData.status)
      return new Response(JSON.stringify({ ok: false, error: msg }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    return new Response(JSON.stringify({
      ok: true,
      needPut: false,
      ext_url: targetDl,
      ext_sync_kind: 'copied',
      targetRel,
      copiedFrom: { repo: parsed.repo, path: parsed.path },
    } satisfies EdgeResult), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return new Response(JSON.stringify({ ok: false, error: msg }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})

