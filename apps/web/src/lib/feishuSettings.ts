import { supabase } from './supabase';

export const FEISHU_SETTINGS_KEY = 'feishu_config';

/** 与 system_settings.feishu_config 一致；Secret 与 Artifactory 一样存库，由已登录用户读取（RLS 与 artifactory_config 相同） */
export type FeishuConfig = {
  appId: string;
  appSecret: string;
};

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
  };
}

export async function saveFeishuSettings(config: FeishuConfig): Promise<void> {
  const { error } = await supabase.from('system_settings').upsert(
    {
      key: FEISHU_SETTINGS_KEY,
      value: {
        appId: config.appId?.trim() ?? '',
        appSecret: config.appSecret ?? '',
      },
    },
    { onConflict: 'key' },
  );
  if (error) throw error;
}
