import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// Helper: Always return 200 with error details in body (so frontend can read them)
const errorResponse = (error: string, details?: string) => {
  console.error('[download-image] Error:', error, details || '')
  return new Response(
    JSON.stringify({
      success: false,
      error,
      details: details || null,
      timestamp: new Date().toISOString()
    }),
    { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  )
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // Parse request body
    let body: { url?: string }
    try {
      body = await req.json()
    } catch (e) {
      return errorResponse('请求体解析失败', e.message)
    }

    const { url } = body

    if (!url) {
      return errorResponse('缺少 url 参数')
    }

    // Validate URL
    let parsedUrl: URL
    try {
      parsedUrl = new URL(url)
    } catch {
      return errorResponse('无效的 URL 格式', url)
    }

    console.log('[download-image] Downloading:', url)

    // Download image from external URL
    let response: Response
    try {
      response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'image/*,*/*;q=0.8',
        },
      })
    } catch (fetchError) {
      return errorResponse('网络请求失败', fetchError.message)
    }

    if (!response.ok) {
      return errorResponse(
        `下载失败: HTTP ${response.status}`,
        `${response.statusText} - ${url}`
      )
    }

    const contentType = response.headers.get('content-type') || 'image/jpeg'
    console.log('[download-image] Content-Type:', contentType)

    // Check if it's an image
    if (!contentType.startsWith('image/')) {
      return errorResponse(
        '目标不是图片',
        `Content-Type: ${contentType}`
      )
    }

    let imageData: ArrayBuffer
    try {
      imageData = await response.arrayBuffer()
    } catch (e) {
      return errorResponse('读取图片数据失败', e.message)
    }

    console.log('[download-image] Downloaded size:', imageData.byteLength, 'bytes')

    // Get authorization header for Supabase client
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return errorResponse('缺少认证信息', '请确保已登录')
    }

    // Create Supabase client
    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const supabaseKey = Deno.env.get('SUPABASE_ANON_KEY')

    if (!supabaseUrl || !supabaseKey) {
      return errorResponse('服务端配置错误', 'SUPABASE_URL 或 SUPABASE_ANON_KEY 未设置')
    }

    const supabase = createClient(supabaseUrl, supabaseKey, {
      global: { headers: { Authorization: authHeader } }
    })

    // Get current user
    const { data: { user }, error: userError } = await supabase.auth.getUser()
    if (userError) {
      return errorResponse('获取用户信息失败', userError.message)
    }
    if (!user) {
      return errorResponse('未登录', '请重新登录后重试')
    }

    console.log('[download-image] User:', user.id)

    // Generate storage path
    const ext = contentType.split('/')[1]?.split(';')[0] || 'jpg'
    const fileName = `${user.id}/${Date.now()}_${Math.random().toString(36).substring(7)}.${ext}`

    // Upload to storage
    const { error: uploadError } = await supabase.storage
      .from('downloaded-images')
      .upload(fileName, imageData, {
        contentType,
        upsert: false
      })

    if (uploadError) {
      return errorResponse(
        'Storage 上传失败',
        `${uploadError.message} (bucket: downloaded-images, path: ${fileName})`
      )
    }

    console.log('[download-image] Uploaded to:', fileName)

    // Insert record into database
    const { data: record, error: insertError } = await supabase
      .from('downloaded_images')
      .insert({
        user_id: user.id,
        original_url: url,
        storage_path: fileName,
        file_name: parsedUrl.pathname.split('/').pop() || 'image',
        file_size: imageData.byteLength,
        mime_type: contentType,
        status: 'completed'
      })
      .select()
      .single()

    if (insertError) {
      // Try to clean up uploaded file
      await supabase.storage.from('downloaded-images').remove([fileName])
      return errorResponse(
        '数据库写入失败',
        `${insertError.message} (table: downloaded_images)`
      )
    }

    console.log('[download-image] Success, record id:', record.id)

    return new Response(
      JSON.stringify({ success: true, data: record }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (error) {
    return errorResponse('未知错误', error.message || String(error))
  }
})
