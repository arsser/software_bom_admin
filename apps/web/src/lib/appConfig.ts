export type AppConfig = {
  supabaseUrl?: string;
  supabaseAnonKey?: string;
};

declare global {
  interface Window {
    __APP_CONFIG__?: AppConfig;
  }
}

const isPlaceholderOrEmpty = (value: string | undefined | null): boolean => {
  if (!value) return true;
  const trimmed = value.trim();
  if (!trimmed) return true;
  if (/^\$\{.+\}$/.test(trimmed)) return true;
  return false;
};

/**
 * 获取应用运行时配置，仅从 window.__APP_CONFIG__ 读取（由 app-config.js 在页面加载时注入）。
 * 本地开发与生产均使用同一方式：复制 app-config.js.example 为 app-config.js 并填入 Supabase URL / anon key。
 */
export function getAppConfig(): Required<AppConfig> {
  const globalConfig: AppConfig | undefined =
    typeof window !== 'undefined' ? (window as any).__APP_CONFIG__ : undefined;

  const supabaseUrl = !isPlaceholderOrEmpty(globalConfig?.supabaseUrl)
    ? (globalConfig!.supabaseUrl as string)
    : '';
  const supabaseAnonKey = !isPlaceholderOrEmpty(globalConfig?.supabaseAnonKey)
    ? (globalConfig!.supabaseAnonKey as string)
    : '';

  return {
    supabaseUrl,
    supabaseAnonKey
  };
}
