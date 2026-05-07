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

/** 飞书云盘扫描写入 status.feishu（无键时视为未扫描） */
export type BomRowFeishuStatus = 'not_scanned' | 'absent' | 'present' | 'error';

/** 与 public.bom_rows.status（JSONB）一致 */
export type BomRowStatusJson = {
  local: BomRowLocalStatus;
  ext: BomRowExtStatus;
  /** worker Artifactory 拉取、主机不一致等说明（与 status.local 配套；状态说明列「本地」行） */
  local_fetch_error?: string | null;
  /** 网页侧 Artifactory 操作（补全 MD5、检查远程大小等；状态说明列「It」行） */
  it_fetch_error?: string | null;
  /** Artifactory-ext 查重/同步等说明（与 status.ext 配套） */
  ext_fetch_error?: string | null;
  /** 飞书侧是否存在预期路径文件（Edge 扫描写入，不经 MD5） */
  feishu?: BomRowFeishuStatus;
  feishu_file_token?: string | null;
  feishu_revision?: string | null;
  feishu_file_name?: string | null;
  feishu_size_bytes?: number | null;
  feishu_scan_error?: string | null;
  feishu_scanned_at?: string | null;
};

export const DEFAULT_BOM_ROW_STATUS: BomRowStatusJson = {
  local: 'pending',
  ext: 'not_started',
};

/** It 行文案前缀：补全 MD5（网页 Storage API） */
export const IT_STATUS_MD5_PREFIX = '[补全·MD5]';
/** It 行文案前缀：检查远程大小 */
export const IT_STATUS_SIZE_PREFIX = '[检查·远程大小]';
/** 历史前缀（写入 It 行；可与 MD5 前缀一并清除） */
export const IT_STATUS_LEGACY_ARTIFACTORY_PREFIX = 'Artifactory：';

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

/** 写入或清除 status.it_fetch_error（null/空串 表示删除该键） */
export function mergeItFetchError(
  status: BomRowStatusJson,
  message: string | null | undefined,
): BomRowStatusJson {
  const next: BomRowStatusJson = { ...status };
  if (message === undefined) return next;
  if (message === null || message === '') {
    delete next.it_fetch_error;
    return next;
  }
  next.it_fetch_error = message.slice(0, 1000);
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

const FEISHU_SET = new Set<string>(['not_scanned', 'absent', 'present', 'error']);

export function isBomRowFeishuStatus(v: string): v is BomRowFeishuStatus {
  return FEISHU_SET.has(v);
}

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
        const itf = o.it_fetch_error;
        const ef = o.ext_fetch_error;
        if (typeof lf === 'string' && lf.trim()) out.local_fetch_error = lf.trim().slice(0, 1000);
        if (typeof itf === 'string' && itf.trim()) out.it_fetch_error = itf.trim().slice(0, 1000);
        if (typeof ef === 'string' && ef.trim()) out.ext_fetch_error = ef.trim().slice(0, 1000);
        const fh = o.feishu;
        if (typeof fh === 'string' && isBomRowFeishuStatus(fh)) out.feishu = fh;
        const fts = o.feishu_file_token;
        if (typeof fts === 'string' && fts.trim()) out.feishu_file_token = fts.trim();
        const fr = o.feishu_revision;
        if (typeof fr === 'string' && fr.trim()) out.feishu_revision = fr.trim();
        const fn = o.feishu_file_name;
        if (typeof fn === 'string' && fn.trim()) out.feishu_file_name = fn.trim();
        if (typeof o.feishu_size_bytes === 'number' && Number.isFinite(o.feishu_size_bytes)) {
          out.feishu_size_bytes = o.feishu_size_bytes;
        }
        const fse = o.feishu_scan_error;
        if (typeof fse === 'string' && fse.trim()) out.feishu_scan_error = fse.trim().slice(0, 1000);
        const fsa = o.feishu_scanned_at;
        if (typeof fsa === 'string' && fsa.trim()) out.feishu_scanned_at = fsa.trim();
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

export const BOM_ROW_FEISHU_STATUS_LABEL: Record<BomRowFeishuStatus, string> = {
  not_scanned: '未扫描',
  absent: '待上传或不一致',
  present: '已与飞书对齐',
  error: '飞书扫描异常',
};

/** 兼容旧 UI：整行摘要（tooltip） */
export function formatBomRowStatusTooltip(s: BomRowStatusJson): string {
  const itSummary = s.it_fetch_error?.trim() ? '需关注' : '正常';
  const feishuPart =
    s.feishu != null
      ? `；飞书：${BOM_ROW_FEISHU_STATUS_LABEL[s.feishu]}（${s.feishu}）`
      : '；飞书：未扫描';
  return `Artifactory：${itSummary}；Artifactory-ext：${BOM_ROW_EXT_STATUS_LABEL[s.ext]}（${s.ext}）；本地：${BOM_ROW_LOCAL_STATUS_LABEL[s.local]}（${s.local}）${feishuPart}`;
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

/** 自动拉取或 ext 同步失败等：原因在 status 各说明字段；页面「状态说明」列为 Artifactory / Artifactory-ext / 本地 分行展示。 */
export const BOM_STATUS_LEGEND_ERROR =
  '自动从 Artifactory 拉取失败、Artifactory-ext 同步失败或主机与配置不一致；详见「状态说明」列（对应 JSON：it_fetch_error、ext_fetch_error、local_fetch_error）。';
