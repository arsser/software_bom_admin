import { supabase } from './supabase';

export const FEISHU_SETTINGS_KEY = 'feishu_config';

/** 与 system_settings.feishu_config 一致；Secret 与 Artifactory 一样存库，由已登录用户读取（RLS 与 artifactory_config 相同） */
export type FeishuConfig = {
  appId: string;
  appSecret: string;
  /**
   * 企业飞书网页域名，用于生成可分享的文件页链接（如 https://xxx.feishu.cn）。
   * 勿填 open.feishu.cn。
   */
  webBaseUrl: string;
};

/** 规范化企业网页域名；非法或 open.* 主机返回空串 */
export function normalizeFeishuWebBaseUrl(raw: unknown): string {
  let s = String(raw ?? '')
    .trim()
    .replace(/\/+$/, '');
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    if (/^open\./i.test(u.hostname)) return '';
    return `${u.protocol}//${u.host}`;
  } catch {
    return '';
  }
}

/** 飞书云空间文件网页链接（浏览器可打开预览/下载；需账号有权限） */
export function buildFeishuFileWebUrl(fileToken: string, webBaseUrl: string): string {
  const tok = String(fileToken ?? '').trim();
  const base = normalizeFeishuWebBaseUrl(webBaseUrl);
  if (!tok || !base) return '';
  return `${base}/file/${encodeURIComponent(tok)}`;
}

/** 飞书电子表格网页链接；未配置企业域名时回退 feishu.cn */
export function buildFeishuSheetWebUrl(sheetToken: string, webBaseUrl = ''): string {
  const tok = String(sheetToken ?? '').trim();
  if (!tok) return '';
  const base = normalizeFeishuWebBaseUrl(webBaseUrl) || 'https://feishu.cn';
  return `${base}/sheets/${encodeURIComponent(tok)}`;
}

/** 飞书云盘文件夹网页链接；未配置企业域名时回退 feishu.cn */
export function buildFeishuFolderWebUrl(folderToken: string, webBaseUrl = ''): string {
  const tok = String(folderToken ?? '').trim();
  if (!tok) return '';
  const base = normalizeFeishuWebBaseUrl(webBaseUrl) || 'https://feishu.cn';
  return `${base}/drive/folder/${encodeURIComponent(tok)}`;
}

export async function fetchFeishuSettings(): Promise<FeishuConfig | null> {
  const { data, error } = await supabase
    .from('system_settings')
    .select('value')
    .eq('key', FEISHU_SETTINGS_KEY)
    .maybeSingle();

  if (error && error.code !== 'PGRST116') {
    console.error('fetchFeishuSettings:', error.message);
    return null;
  }

  const value = (data?.value ?? {}) as Record<string, unknown>;
  return {
    appId: typeof value.appId === 'string' ? value.appId.trim() : '',
    appSecret: typeof value.appSecret === 'string' ? value.appSecret : '',
    webBaseUrl: normalizeFeishuWebBaseUrl(value.webBaseUrl ?? value.web_base_url),
  };
}

export async function saveFeishuSettings(config: FeishuConfig): Promise<void> {
  const { error } = await supabase.from('system_settings').upsert(
    {
      key: FEISHU_SETTINGS_KEY,
      value: {
        appId: config.appId?.trim() ?? '',
        appSecret: config.appSecret ?? '',
        webBaseUrl: normalizeFeishuWebBaseUrl(config.webBaseUrl),
      },
    },
    { onConflict: 'key' },
  );
  if (error) throw error;
}
