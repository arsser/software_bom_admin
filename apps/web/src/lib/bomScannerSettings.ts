import { supabase } from './supabase';

export const BOM_SCANNER_SETTINGS_KEY = 'bom_scanner';

export type BomJsonKeyMap = {
  downloadUrl: string[];
  expectedMd5: string[];
  arch: string[];
  extUrl?: string[];
  /** 写入 Artifactory 拉取的大小（字节，整数字符串） */
  fileSizeBytes?: string[];
  /** 拉取失败等说明 */
  remark?: string[];
};

/** DB 中仅存 scanIntervalSeconds；读库时可能仍有历史 scanIntervalMinutes */
type BomScannerRaw = Partial<{ scanIntervalSeconds: number; scanIntervalMinutes: number; jsonKeyMap: BomJsonKeyMap }>;

export type BomScannerConfig = {
  /** worker 主循环睡眠秒数，与定时入队间隔相同（从 DB 读取） */
  scanIntervalSeconds: number;
  jsonKeyMap: BomJsonKeyMap;
};

const defaultJsonKeyMap: BomJsonKeyMap = {
  downloadUrl: ['下载路径', 'url', 'download_url', '下载地址'],
  expectedMd5: ['MD5', 'md5', 'checksum'],
  arch: ['硬件平台', 'arch', 'platform', '架构'],
  extUrl: ['ext_url', 'extUrl', '转存地址'],
  fileSizeBytes: ['文件大小', 'size_bytes', '远端大小'],
  remark: ['备注', 'note', 'remark'],
};

const defaultConfig: BomScannerConfig = {
  scanIntervalSeconds: 30,
  jsonKeyMap: defaultJsonKeyMap,
};

function clampScanSeconds(n: number): number {
  if (!Number.isFinite(n)) return defaultConfig.scanIntervalSeconds;
  return Math.min(86400, Math.max(5, Math.round(n)));
}

function resolveScanIntervalSeconds(raw: BomScannerRaw | null | undefined): number {
  if (typeof raw?.scanIntervalSeconds === 'number' && Number.isFinite(raw.scanIntervalSeconds)) {
    return clampScanSeconds(raw.scanIntervalSeconds);
  }
  if (typeof raw?.scanIntervalMinutes === 'number' && Number.isFinite(raw.scanIntervalMinutes)) {
    return clampScanSeconds(raw.scanIntervalMinutes * 60);
  }
  return defaultConfig.scanIntervalSeconds;
}

function mergeConfig(raw: BomScannerRaw | null | undefined): BomScannerConfig {
  const jm = raw?.jsonKeyMap;
  return {
    scanIntervalSeconds: resolveScanIntervalSeconds(raw),
    jsonKeyMap: {
      downloadUrl: Array.isArray(jm?.downloadUrl) && jm.downloadUrl.length ? jm.downloadUrl : defaultJsonKeyMap.downloadUrl,
      expectedMd5: Array.isArray(jm?.expectedMd5) && jm.expectedMd5.length ? jm.expectedMd5 : defaultJsonKeyMap.expectedMd5,
      arch: Array.isArray(jm?.arch) && jm.arch.length ? jm.arch : defaultJsonKeyMap.arch,
      extUrl: Array.isArray(jm?.extUrl) && jm.extUrl.length ? jm.extUrl : defaultJsonKeyMap.extUrl,
      fileSizeBytes:
        Array.isArray(jm?.fileSizeBytes) && jm.fileSizeBytes.length ? jm.fileSizeBytes : defaultJsonKeyMap.fileSizeBytes!,
      remark: Array.isArray(jm?.remark) && jm.remark.length ? jm.remark : defaultJsonKeyMap.remark!,
    },
  };
}

export async function fetchBomScannerSettings(): Promise<BomScannerConfig> {
  const { data, error } = await supabase
    .from('system_settings')
    .select('value')
    .eq('key', BOM_SCANNER_SETTINGS_KEY)
    .maybeSingle();

  if (error && error.code !== 'PGRST116') {
    console.error('fetchBomScannerSettings:', error.message);
    return defaultConfig;
  }

  const value = (data?.value ?? {}) as BomScannerRaw;
  return mergeConfig(value);
}

export async function saveBomScannerSettings(config: BomScannerConfig): Promise<void> {
  const merged = mergeConfig(config);
  const { error } = await supabase.from('system_settings').upsert(
    {
      key: BOM_SCANNER_SETTINGS_KEY,
      value: merged,
    },
    { onConflict: 'key' },
  );
  if (error) throw error;
}

export { defaultConfig as defaultBomScannerConfig };
