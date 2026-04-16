import type { BomBatchRow, LocalFileIndexInfo } from './bomBatches';
import type { BomJsonKeyMap } from './bomScannerSettings';
import type { BomRowRecord } from './bomParser';
import { BOM_ROW_LOCAL_STATUS_LABEL } from './bomRowStatus';

function norm(h: string): string {
  return h.trim().toLowerCase();
}

/** 与 Edge/worker 一致：列名可能含零宽/全角空格，与 jsonKeyMap 别名做宽松匹配 */
export function normalizeBomKeyForMatch(s: string): string {
  return String(s)
    .normalize('NFKC')
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .trim()
    .toLowerCase();
}

export function firstNonEmptyByKeys(row: BomRowRecord, keys: string[]): string | null {
  for (const key of keys) {
    if (key in row) {
      const v = (row[key] ?? '').trim();
      if (v) return v;
    }
  }
  return null;
}

/**
 * 先精确匹配别名；再按规范化列名匹配；再匹配列名含「分组」的列（Excel 列名可能带空格/不可见字符）。
 */
export function firstNonEmptyByKeysRelaxed(row: BomRowRecord, keys: string[]): string | null {
  const exact = firstNonEmptyByKeys(row, keys);
  if (exact) return exact;
  const want = new Set(keys.map((k) => normalizeBomKeyForMatch(k)).filter(Boolean));
  for (const [k, val] of Object.entries(row)) {
    if (want.has(normalizeBomKeyForMatch(k))) {
      const v = String(val ?? '').trim();
      if (v) return v;
    }
  }
  for (const [k, val] of Object.entries(row)) {
    if (/分组/.test(String(k))) {
      const v = String(val ?? '').trim();
      if (v) return v;
    }
  }
  return null;
}

export function extractGroupSegmentFromRow(row: BomRowRecord, keyMap: BomJsonKeyMap): string | null {
  const keys = keyMap.groupSegment?.length ? keyMap.groupSegment : ['分组', 'group', 'groupName', '组别'];
  return firstNonEmptyByKeysRelaxed(row, keys);
}

export function extractDownloadUrlRaw(row: BomRowRecord, keyMap: BomJsonKeyMap): string | null {
  return firstNonEmptyByKeys(row, keyMap.downloadUrl);
}

/** 与 bomTableCell 一致：从单元格取可请求的 http(s) URL */
export function extractHttpUrlFromDownloadCell(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  const looseMd = t.match(/\[([^\]]*)\]\(([^)]+)\)/);
  if (looseMd?.[2]) {
    const u = looseMd[2].trim();
    if (/^https?:\/\//i.test(u)) return u;
  }
  if (/^https?:\/\//i.test(t)) return t;
  return null;
}

export function extractExpectedMd5FromRow(row: BomRowRecord, keyMap: BomJsonKeyMap): string | null {
  const v = firstNonEmptyByKeys(row, keyMap.expectedMd5);
  if (!v) return null;
  const lower = v.trim().toLowerCase();
  return /^[a-f0-9]{32}$/.test(lower) ? lower : null;
}

/** ext 转存 URI（jsonb 约定键，见 bom_scanner.jsonKeyMap.extUrl） */
export function extractExtUrlFromRow(row: BomRowRecord, keyMap: BomJsonKeyMap): string | null {
  const keys = keyMap.extUrl?.length ? keyMap.extUrl : ['ext_url', 'extUrl', '转存地址'];
  return firstNonEmptyByKeys(row, keys);
}

/**
 * 分发页「从外部 Artifactory 拉取」前置条件：本地未校验通过时才可能出现拉取；本地已通过则一律不提供（与是否有 ext 链接无关）。
 * 在可拉取前提下：ext 转存须为 https/http 且与 worker 一致须为 Artifactory 类链接（URL 中含 artifactory，不读「下载路径」列）。
 */
export function rowEligibleForDistributeExternalPull(row: BomBatchRow, keyMap: BomJsonKeyMap): boolean {
  const local = row.status.local;
  const md5 = extractExpectedMd5FromRow(row.bom_row, keyMap);
  const localEligibleByStatus =
    local === 'pending' ||
    local === 'error' ||
    ((local === 'verified_ok' || local === 'verified_fail' || local === 'local_found') && Boolean(md5));
  if (!localEligibleByStatus) return false;
  const extRaw = extractExtUrlFromRow(row.bom_row, keyMap);
  if (!extRaw?.trim()) return false;
  const url = extractHttpUrlFromDownloadCell(extRaw);
  const u = url?.trim();
  if (!u || !/^https?:\/\//i.test(u)) return false;
  return /artifactory/i.test(u);
}

/** 解析单元格中的字节数（去千分位/空格；接受数值为整数或极接近整数的浮点） */
function parseByteSizeFromCell(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const t = String(raw).trim().replace(/[,_\s]/g, '');
  if (!t) return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0) return null;
  const r = Math.round(n);
  if (Math.abs(n - r) < 1e-6) return r;
  return null;
}

export function extractRemoteSizeBytesFromRow(row: BomRowRecord, keyMap: BomJsonKeyMap): number | null {
  const keys = keyMap.fileSizeBytes ?? [];
  if (!keys.length) return null;
  const raw = firstNonEmptyByKeysRelaxed(row, keys);
  return parseByteSizeFromCell(raw);
}

/** 外部 Artifactory 写入 jsonb 的大小（字节） */
export function extractExtSizeBytesFromRow(row: BomRowRecord, keyMap: BomJsonKeyMap): number | null {
  const keys = keyMap.extFileSizeBytes ?? [];
  if (!keys.length) return null;
  const raw = firstNonEmptyByKeysRelaxed(row, keys);
  return parseByteSizeFromCell(raw);
}

/** 原始 BOM 表中的备注列（jsonKeyMap.remark）；仅展示，系统功能（如 Artifactory 补全 MD5）不应写入。 */
export function extractRemarkFromRow(row: BomRowRecord, keyMap: BomJsonKeyMap): string | null {
  const keys = keyMap.remark ?? [];
  if (!keys.length) return null;
  return firstNonEmptyByKeys(row, keys);
}

/** 写入别名组：优先覆盖已有列，否则使用别名列表第一个新建 */
export function setRowFieldByAliases(row: BomRowRecord, aliases: string[], value: string): BomRowRecord {
  const next: BomRowRecord = { ...row };
  if (!aliases.length) return next;
  const hit = aliases.find((k) => Object.prototype.hasOwnProperty.call(next, k));
  const key = hit ?? aliases[0];
  if (key) next[key] = value;
  return next;
}

/** 识别备注列表头（jsonKeyMap.remark）；与导入表头顺序一起出现在动态列中，并用于只读展示样式（与默认 jsonKeyMap.remark 一致） */
export function remarkColumnKeys(keyMap: BomJsonKeyMap): string[] {
  return keyMap.remark?.length ? keyMap.remark : ['备注', 'note', 'remark'];
}

export function headerMatchesAny(header: string, keys: string[]): boolean {
  const n = norm(header);
  return keys.some((k) => norm(k) === n);
}

/** 与 DB eligible 语义对齐：可网页/worker 从内部 Artifactory 拉取 */
export function rowEligibleForItPull(
  row: BomBatchRow,
  keyMap: BomJsonKeyMap,
  localInfoByMd5: Map<string, LocalFileIndexInfo>,
): boolean {
  const raw = extractDownloadUrlRaw(row.bom_row, keyMap);
  if (!raw) return false;
  const url = extractHttpUrlFromDownloadCell(raw);
  if (!url) return false;
  if (!/artifactory/i.test(url)) return false;
  const md5 = extractExpectedMd5FromRow(row.bom_row, keyMap);
  const fileInIndex = Boolean(md5 && localInfoByMd5.has(md5));
  if (fileInIndex) return false;

  const { local } = row.status;
  const indexMissButDbSaysHadFile =
    Boolean(md5) &&
    (local === 'verified_ok' || local === 'verified_fail' || local === 'local_found');
  if (local !== 'pending' && local !== 'error' && !indexMissButDbSaysHadFile) return false;
  return true;
}

/** 阶段 5：校验通过且尚未写入 ext_url，可排队 ext 同步 */
export function rowEligibleForExtSync(row: BomBatchRow, keyMap: BomJsonKeyMap): boolean {
  const ext = extractExtUrlFromRow(row.bom_row, keyMap);
  if (ext && ext.trim()) return false;

  if (row.status.local !== 'verified_ok') return false;

  const md5 = extractExpectedMd5FromRow(row.bom_row, keyMap);
  if (!md5) return false;

  return true;
}

/**
 * 行内 ext 按钮：校验通过、尚无 ext_url、有 MD5，且本地索引已命中路径（与改之前的展示条件一致）。
 */
export function rowEligibleForExtCheckCopy(row: BomBatchRow, keyMap: BomJsonKeyMap): boolean {
  if (row.status.ext === 'synced_or_skipped') return false;
  const ext = extractExtUrlFromRow(row.bom_row, keyMap);
  if (ext && ext.trim()) return false;
  const md5 = extractExpectedMd5FromRow(row.bom_row, keyMap);
  if (!md5) return false;
  return true;
}

/**
 * 与表格「ext」摘要一致：已写入 ext 转存链接，或 DB 中 ext 状态为已转存/跳过，即视为 ext 侧已完成。
 */
export function rowExtUiComplete(row: BomBatchRow, keyMap: BomJsonKeyMap): boolean {
  const extRaw = extractExtUrlFromRow(row.bom_row, keyMap);
  if (Boolean(extRaw?.trim())) return true;
  return row.status.ext === 'synced_or_skipped';
}

/**
 * 不增 DB 列：由 status.local / status.ext、ext_url、索引命中推导「本地 / ext」两行摘要。
 * @param indexedMd5Hit `true`/`false`：当前页已加载的 local_file（按 MD5）是否命中；`null`：尚无 MD5 或索引查询未完成，不覆盖展示。
 */
export function deriveLocalExtStatusLabels(
  row: BomBatchRow,
  keyMap: BomJsonKeyMap,
  indexedMd5Hit: boolean | null,
): { localLabel: string; extLabel: string } {
  const { local, ext } = row.status;

  let localLabel = BOM_ROW_LOCAL_STATUS_LABEL[local];

  let extLabel: string;
  if (rowExtUiComplete(row, keyMap)) {
    extLabel = '已完成';
  } else if (ext === 'error') {
    extLabel = '同步失败';
  } else if (local === 'verified_ok') {
    extLabel = '未写入';
  } else {
    extLabel = '未开始';
  }

  if (indexedMd5Hit === false) {
    if (local === 'verified_ok' || local === 'verified_fail' || local === 'local_found') {
      localLabel = '文件不存在';
    } else if (ext === 'synced_or_skipped') {
      localLabel = '无本地副本';
    }
  }

  return { localLabel, extLabel };
}

/** 从相对/绝对路径取文件名（用于表格展示） */
export function fileBasename(path: string): string {
  const t = path.replace(/\\/g, '/').trim();
  if (!t) return '';
  const i = t.lastIndexOf('/');
  return i >= 0 ? t.slice(i + 1) : t;
}

/** worker 写入的 path：相对 BOM_LOCAL_ROOT，统一为正斜杠便于展示 */
export function normalizeLocalRelativePath(path: string): string {
  return String(path ?? '')
    .trim()
    .replace(/\\/g, '/');
}
