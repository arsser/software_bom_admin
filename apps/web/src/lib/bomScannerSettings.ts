import { supabase } from './supabase';

export const BOM_SCANNER_SETTINGS_KEY = 'bom_scanner';

export type BomJsonKeyMap = {
  downloadUrl: string[];
  expectedMd5: string[];
  arch: string[];
  extUrl?: string[];
  /** ext 同步目标路径：版本段（如 v1.0） */
  releaseVersion?: string[];
  /** 发布版本段（releaseBatch；表头别名仍可匹配「批次」等历史列名） */
  releaseBatch?: string[];
  /** 模块 / 组件段 */
  moduleName?: string[];
  /** ext 同步目录：分组子目录（对应 bom_row 中的列名别名） */
  groupSegment?: string[];
  /** 写入内部 Artifactory 拉取/补全的大小（字节，整数字符串） */
  fileSizeBytes?: string[];
  /** 外部 Artifactory 侧大小（字节，整数字符串） */
  extFileSizeBytes?: string[];
  /** 拉取失败等说明 */
  remark?: string[];
};

/** worker 心跳与超时（与 bom-scanner-worker 共用，存 DB） */
export type BomWorkerTuning = {
  /** 心跳 / runtime 上报 / 取消轮询 / 进度节流统一间隔（毫秒） */
  heartbeatMs: number;
  /** 单次 HTTP 请求超时：下载与上传共用（毫秒） */
  httpTimeoutMs: number;
  /** HTTP 请求失败后最大重试次数（0 = 不重试） */
  httpRetries: number;
};

export const defaultWorkerTuning: BomWorkerTuning = {
  heartbeatMs: 15000,
  httpTimeoutMs: 3600000,
  httpRetries: 2,
};

/** 与 worker 内 resolveWorkerTuning 钳制一致 */
export function mergeWorkerTuning(raw: unknown): BomWorkerTuning {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const n = (k: keyof BomWorkerTuning, def: number, min: number, max?: number) => {
    const v = o[k];
    let x = typeof v === 'number' && Number.isFinite(v) ? v : def;
    if (x < min) x = min;
    if (max != null && x > max) x = max;
    return Math.round(x);
  };
  return {
    heartbeatMs: n('heartbeatMs', defaultWorkerTuning.heartbeatMs, 5000, 120000),
    httpTimeoutMs: Math.max(1000, n('httpTimeoutMs', defaultWorkerTuning.httpTimeoutMs, 1000)),
    httpRetries: n('httpRetries', defaultWorkerTuning.httpRetries, 0, 10),
  };
}

/** DB 中仅存 scanIntervalSeconds；读库时可能仍有历史 scanIntervalMinutes */
type BomScannerRaw = Partial<{
  scanIntervalSeconds: number;
  scanIntervalMinutes: number;
  jsonKeyMap: BomJsonKeyMap;
  /** 外部 Artifactory 仓库 key（阶段 5 同步目标） */
  extArtifactoryRepo: string;
  workerTuning: Partial<BomWorkerTuning> | Record<string, unknown>;
  runtime: Partial<{
    workerLocalRoot: string;
    workerReportedAt: string;
    /** idle | busy，由 worker 写入 */
    workerPhase?: string;
    workerBusyHint?: string;
  }>;
}>;

export type BomScannerConfig = {
  /** worker 主循环睡眠秒数，与定时入队间隔相同（从 DB 读取） */
  scanIntervalSeconds: number;
  jsonKeyMap: BomJsonKeyMap;
  /** ext 目标仓库 key，空则无法在网页排队同步任务 */
  extArtifactoryRepo: string;
  /** 拉取/上传/扫描等间隔，由 worker 每轮读取 */
  workerTuning: BomWorkerTuning;
  /** worker 回报的当前生效本地根目录（仅展示） */
  workerLocalRoot?: string;
  /** worker 回报时间（ISO） */
  workerReportedAt?: string;
  /** worker 当前是否处于长任务（拉取/同步/扫描等） */
  workerPhase?: string;
  workerBusyHint?: string;
};

const defaultJsonKeyMap: BomJsonKeyMap = {
  downloadUrl: ['下载路径', 'url', 'download_url', '下载地址'],
  expectedMd5: ['MD5', 'md5', 'checksum'],
  arch: ['硬件平台', 'arch', 'platform', '架构'],
  extUrl: ['ext_url', 'extUrl', '转存地址'],
  releaseVersion: ['版本', 'version', 'releaseVersion', '产品版本'],
  releaseBatch: ['批次', 'batch', 'releaseBatch', '发布批次'],
  moduleName: ['模块', 'module', '组件', 'moduleName'],
  groupSegment: ['分组', 'group', 'groupName', '组别'],
  fileSizeBytes: ['文件大小', 'size_bytes', '远端大小'],
  extFileSizeBytes: ['ext_size_bytes', 'ext文件大小', 'extSize', 'ext大小'],
  remark: ['备注', 'note', 'remark'],
};

const defaultConfig: BomScannerConfig = {
  scanIntervalSeconds: 30,
  jsonKeyMap: defaultJsonKeyMap,
  extArtifactoryRepo: '',
  workerTuning: { ...defaultWorkerTuning },
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

function optArr(jm: BomJsonKeyMap | undefined, k: keyof BomJsonKeyMap, fallback: string[] | undefined): string[] | undefined {
  const v = jm?.[k];
  return Array.isArray(v) && v.length && v.every((x) => typeof x === 'string') ? v : fallback;
}

function mergeConfig(raw: BomScannerRaw | null | undefined): BomScannerConfig {
  const jm = raw?.jsonKeyMap;
  return {
    scanIntervalSeconds: resolveScanIntervalSeconds(raw),
    extArtifactoryRepo: typeof raw?.extArtifactoryRepo === 'string' ? raw.extArtifactoryRepo.trim() : '',
    workerTuning: mergeWorkerTuning(raw?.workerTuning),
    workerLocalRoot: typeof raw?.runtime?.workerLocalRoot === 'string' ? raw.runtime.workerLocalRoot.trim() : undefined,
    workerReportedAt: typeof raw?.runtime?.workerReportedAt === 'string' ? raw.runtime.workerReportedAt : undefined,
    workerPhase: typeof raw?.runtime?.workerPhase === 'string' ? raw.runtime.workerPhase : undefined,
    workerBusyHint: typeof raw?.runtime?.workerBusyHint === 'string' ? raw.runtime.workerBusyHint : undefined,
    jsonKeyMap: {
      downloadUrl: Array.isArray(jm?.downloadUrl) && jm.downloadUrl.length ? jm.downloadUrl : defaultJsonKeyMap.downloadUrl,
      expectedMd5: Array.isArray(jm?.expectedMd5) && jm.expectedMd5.length ? jm.expectedMd5 : defaultJsonKeyMap.expectedMd5,
      arch: Array.isArray(jm?.arch) && jm.arch.length ? jm.arch : defaultJsonKeyMap.arch,
      extUrl: Array.isArray(jm?.extUrl) && jm.extUrl.length ? jm.extUrl : defaultJsonKeyMap.extUrl,
      releaseVersion: optArr(jm, 'releaseVersion', defaultJsonKeyMap.releaseVersion),
      releaseBatch: optArr(jm, 'releaseBatch', defaultJsonKeyMap.releaseBatch),
      moduleName: optArr(jm, 'moduleName', defaultJsonKeyMap.moduleName),
      groupSegment: optArr(jm, 'groupSegment', defaultJsonKeyMap.groupSegment),
      fileSizeBytes:
        Array.isArray(jm?.fileSizeBytes) && jm.fileSizeBytes.length ? jm.fileSizeBytes : defaultJsonKeyMap.fileSizeBytes!,
      extFileSizeBytes: optArr(jm, 'extFileSizeBytes', defaultJsonKeyMap.extFileSizeBytes),
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
  const { data: curData } = await supabase
    .from('system_settings')
    .select('value')
    .eq('key', BOM_SCANNER_SETTINGS_KEY)
    .maybeSingle();
  const cur = (curData?.value ?? {}) as Record<string, unknown>;

  const { error } = await supabase.from('system_settings').upsert(
    {
      key: BOM_SCANNER_SETTINGS_KEY,
      value: {
        ...cur,
        scanIntervalSeconds: merged.scanIntervalSeconds,
        jsonKeyMap: merged.jsonKeyMap,
        extArtifactoryRepo: merged.extArtifactoryRepo,
        workerTuning: merged.workerTuning,
      },
    },
    { onConflict: 'key' },
  );
  if (error) throw error;
}

export { defaultConfig as defaultBomScannerConfig };
