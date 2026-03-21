import { createClient } from '@supabase/supabase-js';
import { getAppConfig } from './appConfig';

const { supabaseUrl: rawSupabaseUrl, supabaseAnonKey } = getAppConfig();

if (!rawSupabaseUrl || !supabaseAnonKey) {
  throw new Error(
    'Missing Supabase configuration. 请复制 public/app-config.js.example 为 app-config.js 并填入 supabaseUrl、supabaseAnonKey。'
  );
}

const supabaseUrl = (() => {
  const trimmed = rawSupabaseUrl.trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new Error(`Invalid supabase URL: "${trimmed}". It must start with http:// or https://`);
  }
  try {
    new URL(trimmed);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid supabase URL: "${trimmed}". ${msg}`);
  }
  return trimmed;
})();

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: true,
    // 关闭自动刷新，避免后端不可达时客户端持续重试导致浏览器一直发请求
    autoRefreshToken: false,
  }
});
