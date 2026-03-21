import { getAppConfig } from '../lib/appConfig';

/**
 * 将相对路径转换为完整的附件URL
 * @param relativePath - 相对路径
 * @param downloadFileName - 下载时的文件名（可选）
 * @param bucket - 存储桶名称，默认 "downloaded-images"
 * @returns 完整的附件URL
 */
export function getFileUrl(
  relativePath: string | null | undefined,
  downloadFileName?: string | null,
  bucket: string = 'downloaded-images'
): string | null {
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
  const baseUrl = `${supabaseUrl}/storage/v1/object/public/${bucket}/${cleanPath}`;
  if (downloadFileName) {
    const encodedName = encodeURIComponent(downloadFileName);
    return `${baseUrl}?download=${encodedName}`;
  }
  return baseUrl;
}
