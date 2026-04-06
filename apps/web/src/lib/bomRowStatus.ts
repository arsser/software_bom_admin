/** DB: bom_rows.status JSONB 中 status->>'local' 的取值 */
export type BomRowLocalStatus =
  | 'pending'
  | 'await_manual_download'
  /** @deprecated 新逻辑下较少出现 */
  | 'local_found'
  | 'verified_ok'
  | 'verified_fail'
  | 'error';

/** DB: bom_rows.status JSONB 中 status->>'ext' 的取值 */
export type BomRowExtStatus = 'not_started' | 'synced_or_skipped' | 'error';

/** 与 public.bom_rows.status（JSONB）一致 */
export type BomRowStatusJson = {
  local: BomRowLocalStatus;
  ext: BomRowExtStatus;
  /** it/本地拉取、补全 MD5 等说明（与 status.local 配套） */
  local_fetch_error?: string | null;
  /** ext-Artifactory 查重/同步等说明（与 status.ext 配套） */
  ext_fetch_error?: string | null;
};

export const DEFAULT_BOM_ROW_STATUS: BomRowStatusJson = {
  local: 'pending',
  ext: 'not_started',
};

/** 写入或清除 status.local_fetch_error（null/空串 表示删除该键） */
export function mergeLocalFetchError(
  status: BomRowStatusJson,
  message: string | null | undefined,
): BomRowStatusJson {
  const next: BomRowStatusJson = { ...status };
  if (message === undefined) return next;
  if (message === null || message === '') {
    delete next.local_fetch_error;
    return next;
  }
  next.local_fetch_error = message.slice(0, 1000);
  return next;
}

const LOCAL_SET = new Set<string>([
  'pending',
  'await_manual_download',
  'local_found',
  'verified_ok',
  'verified_fail',
  'error',
]);

const EXT_SET = new Set<string>(['not_started', 'synced_or_skipped', 'error']);

export function isBomRowLocalStatus(v: string): v is BomRowLocalStatus {
  return LOCAL_SET.has(v);
}

export function isBomRowExtStatus(v: string): v is BomRowExtStatus {
  return EXT_SET.has(v);
}

/** 解析 PostgREST 返回的 status（JSON 对象） */
export function parseBomRowStatus(raw: unknown): BomRowStatusJson {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const o = raw as Record<string, unknown>;
    const local = o.local;
    const ext = o.ext;
    if (typeof local === 'string' && typeof ext === 'string') {
      if (isBomRowLocalStatus(local) && isBomRowExtStatus(ext)) {
        const out: BomRowStatusJson = { local, ext };
        const lf = o.local_fetch_error;
        const ef = o.ext_fetch_error;
        if (typeof lf === 'string' && lf.trim()) out.local_fetch_error = lf.trim().slice(0, 1000);
        if (typeof ef === 'string' && ef.trim()) out.ext_fetch_error = ef.trim().slice(0, 1000);
        return out;
      }
    }
  }
  return { ...DEFAULT_BOM_ROW_STATUS };
}

export const BOM_ROW_LOCAL_STATUS_LABEL: Record<BomRowLocalStatus, string> = {
  pending: '待处理',
  await_manual_download: '待人工下载',
  local_found: '本地已发现',
  verified_ok: '校验通过',
  verified_fail: '校验失败',
  error: '异常',
};

export const BOM_ROW_EXT_STATUS_LABEL: Record<BomRowExtStatus, string> = {
  not_started: '未开始',
  synced_or_skipped: '已转存（或跳过）',
  error: '异常',
};

/** 兼容旧 UI：整行摘要（tooltip） */
export function formatBomRowStatusTooltip(s: BomRowStatusJson): string {
  return `本地：${BOM_ROW_LOCAL_STATUS_LABEL[s.local]}（${s.local}）；ext：${BOM_ROW_EXT_STATUS_LABEL[s.ext]}（${s.ext}）`;
}

/** @deprecated 旧单一枚举，仅用于文档/迁移对照 */
export type BomRowStatusLegacy =
  | 'pending'
  | 'await_manual_download'
  | 'local_found'
  | 'verified_ok'
  | 'verified_fail'
  | 'synced_or_skipped'
  | 'error';

export const BOM_ROW_STATUS_LABEL_LEGACY: Record<BomRowStatusLegacy, string> = {
  pending: '待处理',
  await_manual_download: '待人工下载',
  local_found: '本地已发现',
  verified_ok: '校验通过',
  verified_fail: '校验失败',
  synced_or_skipped: '已转存（或跳过）',
  error: '异常',
};

/** 版本明细表格下方仅展示一次：与「待处理」状态对应的含义说明 */
export const BOM_STATUS_LEGEND_PENDING =
  '本地未找到：索引中尚无与此期望 MD5 一致的文件；将文件放入暂存目录并扫描后可恢复。';

/** 版本明细表格下方仅展示一次：与「校验通过」状态对应的含义说明 */
export const BOM_STATUS_LEGEND_VERIFIED_OK = '本地索引中已存在与期望 MD5 一致的内容。';

/** 非自动拉取链接：需人工下载后放入 BOM 暂存目录，再触发扫描。 */
export const BOM_STATUS_LEGEND_MANUAL =
  '链接不支持自动拉取，请自行下载并放入暂存目录，保存后由扫描更新索引与状态。';

/** 自动拉取或 ext 同步失败等：原因在 status.local_fetch_error / status.ext_fetch_error，页面「状态说明」列以「本地：」「ext：」前缀同行展示。 */
export const BOM_STATUS_LEGEND_ERROR =
  '自动从 it-Artifactory 拉取失败、ext-Artifactory 同步失败或主机与配置不一致；详见「状态说明」列（对应 JSON 内 local_fetch_error / ext_fetch_error）。';
