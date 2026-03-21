import { getAppConfig } from '../lib/appConfig';

/**
 * 将相对路径转换为完整的图片URL
 * @param relativePath - 相对路径
 * @param bucket - 存储桶名称，默认 "downloaded-images"
 * @returns 完整的图片URL
 */
export function getImageUrl(relativePath: string | null | undefined, bucket: string = 'downloaded-images'): string | null {
  if (!relativePath) {
    return null;
  }

  if (relativePath.startsWith('http://') || relativePath.startsWith('https://')) {
    return relativePath;
  }

  const { supabaseUrl } = getAppConfig();
  if (!supabaseUrl) {
    console.error(
      'Supabase URL is not configured. 请在 app-config.js 中配置 window.__APP_CONFIG__.supabaseUrl。'
    );
    return null;
  }

  const cleanPath = relativePath.startsWith('/') ? relativePath.slice(1) : relativePath;
  return `${supabaseUrl}/storage/v1/object/public/${bucket}/${cleanPath}`;
}

