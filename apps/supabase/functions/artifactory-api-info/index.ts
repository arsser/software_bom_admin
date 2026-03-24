import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'

const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

export interface ApiInfo {
  repo?: string
  path?: string
  created?: string
  createdBy?: string
  lastModified?: string
  modifiedBy?: string
  downloadUri?: string
  mimeType?: string
  size?: number
  checksums?: {
    sha1: string
    sha256: string
    md5: string
  }
  originalChecksums?: {
    sha1: string
    sha256: string
    md5: string
  }
  uri?: string
}

export interface ApiInfoResult {
  url: string
  ok: boolean
  info?: ApiInfo
  error?: string
  status?: number
}

type GetApiInfoBody = {
  urls?: string[]
  apiKey?: string
  config?: {
    artifactoryBaseUrl?: string
    artifactoryApiKey?: string
    artifactoryExtBaseUrl?: string
    artifactoryExtApiKey?: string
  }
}

const TIMEOUT_MS = 15000

function normalizeBaseUrl(url?: string | null): string | undefined {
  if (!url) return undefined
  return url.trim().replace(/\/+$/, '')
}

function buildHeaders(apiKey?: string): HeadersInit {
  const headers: Record<string, string> = {
    'User-Agent': 'software-bom-admin/1.0',
    Accept: 'application/json',
  }
  if (apiKey) {
    headers['X-JFrog-Art-Api'] = apiKey
    headers['X-Api-Key'] = apiKey
  }
  return headers
}

function toStorageApiUrl(rawUrl: string): string | null {
  try {
    const u = new URL(rawUrl)
    if (u.pathname.includes('/api/storage/')) {
      return rawUrl
    }
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

async function getSingleApiInfo(url: string, headers: HeadersInit): Promise<ApiInfoResult> {
  const apiUrl = toStorageApiUrl(url)
  if (!apiUrl) {
    return { url, ok: false, error: 'Invalid Artifactory URL' }
  }

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS)

    const res = await fetch(apiUrl, {
      method: 'GET',
      headers,
      signal: controller.signal,
    })
    clearTimeout(timeout)

    if (!res.ok) {
      const errorBody = await res.text()
      let errorMsg = `HTTP ${res.status}`
      if (res.status === 404) errorMsg = 'File not found (404)'
      else if (res.status === 401 || res.status === 403) errorMsg = 'Authorization failed (401/403)'
      else if (errorBody) {
        try {
          const errJson = JSON.parse(errorBody)
          errorMsg = errJson?.errors?.[0]?.message || errorBody
        } catch {
          errorMsg = errorBody.slice(0, 100)
        }
      }
      return { url, ok: false, status: res.status, error: errorMsg }
    }

    const data = (await res.json()) as Record<string, unknown>

    const info: ApiInfo = {
      repo: data.repo as string | undefined,
      path: data.path as string | undefined,
      created: data.created as string | undefined,
      createdBy: data.createdBy as string | undefined,
      lastModified: data.lastModified as string | undefined,
      modifiedBy: data.modifiedBy as string | undefined,
      downloadUri: data.downloadUri as string | undefined,
      mimeType: data.mimeType as string | undefined,
      size: data.size != null ? Number(data.size) : undefined,
      checksums: data.checksums as ApiInfo['checksums'],
      originalChecksums: data.originalChecksums as ApiInfo['originalChecksums'],
      uri: data.uri as string | undefined,
    }

    return { url, ok: true, info, status: res.status }
  } catch (e: unknown) {
    const err = e as { name?: string; message?: string }
    let error = err.message || String(e)
    if (err.name === 'AbortError') error = 'Request timed out'
    return { url, ok: false, error }
  }
}

async function getApiInfo(dto: GetApiInfoBody): Promise<ApiInfoResult[]> {
  const { urls, config, apiKey } = dto
  if (!urls || !Array.isArray(urls)) {
    return []
  }

  const primaryBase = normalizeBaseUrl(config?.artifactoryBaseUrl)
  const extBase = normalizeBaseUrl(config?.artifactoryExtBaseUrl)

  const results = await Promise.all(
    urls.map(async (url) => {
      if (!url || !url.trim()) return null
      let cleanUrl = url.trim()
      try {
        const u = new URL(cleanUrl)
        u.pathname = u.pathname.replace(/\/+/g, '/')
        cleanUrl = u.toString()

        let headers: HeadersInit = {}
        if (config) {
          if (primaryBase && cleanUrl.startsWith(primaryBase)) {
            headers = buildHeaders(config.artifactoryApiKey)
          } else if (extBase && cleanUrl.startsWith(extBase)) {
            headers = buildHeaders(config.artifactoryExtApiKey)
          } else {
            headers = buildHeaders(apiKey)
          }
        } else {
          headers = buildHeaders(apiKey)
        }

        return await getSingleApiInfo(cleanUrl, headers)
      } catch {
        return await getSingleApiInfo(cleanUrl, {})
      }
    }),
  )

  return results.filter((r): r is ApiInfoResult => r !== null)
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  try {
    let body: GetApiInfoBody
    try {
      body = await req.json()
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    if (!body.urls?.length) {
      return new Response(JSON.stringify({ error: 'urls is required and must be non-empty' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const data = await getApiInfo(body)
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
