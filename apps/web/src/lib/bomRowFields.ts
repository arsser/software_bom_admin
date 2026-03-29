import type { BomJsonKeyMap } from './bomScannerSettings';
import type { BomRowRecord } from './bomParser';

function norm(h: string): string {
  return h.trim().toLowerCase();
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

export function extractRemoteSizeBytesFromRow(row: BomRowRecord, keyMap: BomJsonKeyMap): number | null {
  const keys = keyMap.fileSizeBytes ?? [];
  if (!keys.length) return null;
  const raw = firstNonEmptyByKeys(row, keys);
  if (!raw) return null;
  const n = Number(raw.trim().replace(/[,_\s]/g, ''));
  return Number.isFinite(n) && n >= 0 && Number.isInteger(n) ? n : null;
}

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

export function remarkColumnKeys(keyMap: BomJsonKeyMap): string[] {
  return keyMap.remark?.length ? keyMap.remark : ['备注'];
}

export function headerMatchesAny(header: string, keys: string[]): boolean {
  const n = norm(header);
  return keys.some((k) => norm(k) === n);
}

/** 从相对/绝对路径取文件名（用于表格展示） */
export function fileBasename(path: string): string {
  const t = path.replace(/\\/g, '/').trim();
  if (!t) return '';
  const i = t.lastIndexOf('/');
  return i >= 0 ? t.slice(i + 1) : t;
}
