import type { BomBatchRow } from './bomBatches';
import type { BomJsonKeyMap } from './bomScannerSettings';
import type { BomRowRecord } from './bomParser';
import {
  extractComponentFromRow,
  extractDownloadUrlRaw,
  extractExpectedMd5FromRow,
  extractHttpUrlFromDownloadCell,
  extractModuleFromRow,
  fileBasename,
  firstNonEmptyByKeysRelaxed,
} from './bomRowFields';

export type BomCompareKind = 'only_a' | 'only_b' | 'changed' | 'same';

export type BomCompareFieldDiff = {
  key: string;
  label: string;
  valueA: string;
  valueB: string;
};

/** 用于展示与比对的行摘要 */
export type BomCompareRowSnapshot = {
  rowId: string;
  md5: string;
  module: string;
  component: string;
  fileName: string;
  downloadUrl: string;
  arch: string;
  sizeLabel: string;
  /** 参与相等判定的规范化字段 */
  compareFields: Record<string, string>;
};

export type BomCompareItem = {
  kind: BomCompareKind;
  md5: string;
  a: BomCompareRowSnapshot | null;
  b: BomCompareRowSnapshot | null;
  fieldDiffs: BomCompareFieldDiff[];
};

export type BomCompareResult = {
  onlyA: BomCompareItem[];
  onlyB: BomCompareItem[];
  changed: BomCompareItem[];
  same: BomCompareItem[];
  unalignedA: BomBatchRow[];
  unalignedB: BomBatchRow[];
  counts: {
    onlyA: number;
    onlyB: number;
    changed: number;
    same: number;
    unalignedA: number;
    unalignedB: number;
  };
};

const FIELD_LABELS: Record<string, string> = {
  module: '模块/分组',
  component: '组件',
  fileName: '文件名',
  downloadUrl: '下载路径',
  arch: '架构',
  sizeLabel: '文件大小',
};

function extractArch(row: BomRowRecord, keyMap: BomJsonKeyMap): string {
  const keys = keyMap.arch?.length ? keyMap.arch : ['硬件平台', 'arch', 'platform', '架构'];
  return firstNonEmptyByKeysRelaxed(row, keys) ?? '';
}

function extractSizeLabel(row: BomRowRecord, keyMap: BomJsonKeyMap): string {
  const keys = keyMap.fileSizeBytes?.length
    ? keyMap.fileSizeBytes
    : ['文件大小', 'size_bytes', '远端大小'];
  return firstNonEmptyByKeysRelaxed(row, keys) ?? '';
}

function normalizeUrlForCompare(raw: string): string {
  const http = extractHttpUrlFromDownloadCell(raw);
  const t = (http || raw).trim();
  if (!t) return '';
  try {
    const u = new URL(t);
    u.hash = '';
    return u.toString();
  } catch {
    return t;
  }
}

export function buildBomCompareSnapshot(
  row: BomBatchRow,
  keyMap: BomJsonKeyMap,
): BomCompareRowSnapshot | null {
  const md5 = extractExpectedMd5FromRow(row.bom_row, keyMap);
  if (!md5) return null;

  const downloadRaw = extractDownloadUrlRaw(row.bom_row, keyMap) ?? '';
  const downloadUrl = downloadRaw.trim();
  const http = extractHttpUrlFromDownloadCell(downloadUrl);
  let fileName = '';
  if (http) {
    try {
      fileName = fileBasename(new URL(http).pathname);
    } catch {
      fileName = fileBasename(http);
    }
  } else if (downloadUrl) {
    fileName = fileBasename(downloadUrl);
  }

  const module = extractModuleFromRow(row.bom_row, keyMap) ?? '';
  const component = extractComponentFromRow(row.bom_row, keyMap) ?? '';
  const arch = extractArch(row.bom_row, keyMap);
  const sizeLabel = extractSizeLabel(row.bom_row, keyMap);

  return {
    rowId: row.id,
    md5,
    module,
    component,
    fileName,
    downloadUrl,
    arch,
    sizeLabel,
    compareFields: {
      module: module.normalize('NFKC').trim(),
      component: component.normalize('NFKC').trim(),
      fileName: fileName.normalize('NFKC').trim(),
      downloadUrl: normalizeUrlForCompare(downloadUrl),
      arch: arch.normalize('NFKC').trim(),
      sizeLabel: sizeLabel.replace(/,/g, '').replace(/\s+/g, '').trim(),
    },
  };
}

function diffSnapshots(
  a: BomCompareRowSnapshot,
  b: BomCompareRowSnapshot,
): BomCompareFieldDiff[] {
  const diffs: BomCompareFieldDiff[] = [];
  for (const key of Object.keys(FIELD_LABELS)) {
    const va = a.compareFields[key] ?? '';
    const vb = b.compareFields[key] ?? '';
    if (va !== vb) {
      diffs.push({
        key,
        label: FIELD_LABELS[key] || key,
        valueA: a[key as keyof BomCompareRowSnapshot] as string,
        valueB: b[key as keyof BomCompareRowSnapshot] as string,
      });
    }
  }
  return diffs;
}

/**
 * 按期望 MD5 比较两个版本的 BOM 行。
 * 同 MD5 多行时取首次出现（与业务「文件不重名 / MD5 唯一」假设一致）。
 */
export function compareBomVersions(
  rowsA: BomBatchRow[],
  rowsB: BomBatchRow[],
  keyMap: BomJsonKeyMap,
): BomCompareResult {
  const mapA = new Map<string, BomCompareRowSnapshot>();
  const mapB = new Map<string, BomCompareRowSnapshot>();
  const unalignedA: BomBatchRow[] = [];
  const unalignedB: BomBatchRow[] = [];

  for (const r of rowsA) {
    const snap = buildBomCompareSnapshot(r, keyMap);
    if (!snap) {
      unalignedA.push(r);
      continue;
    }
    if (!mapA.has(snap.md5)) mapA.set(snap.md5, snap);
  }
  for (const r of rowsB) {
    const snap = buildBomCompareSnapshot(r, keyMap);
    if (!snap) {
      unalignedB.push(r);
      continue;
    }
    if (!mapB.has(snap.md5)) mapB.set(snap.md5, snap);
  }

  const onlyA: BomCompareItem[] = [];
  const onlyB: BomCompareItem[] = [];
  const changed: BomCompareItem[] = [];
  const same: BomCompareItem[] = [];

  for (const [md5, a] of mapA) {
    const b = mapB.get(md5);
    if (!b) {
      onlyA.push({ kind: 'only_a', md5, a, b: null, fieldDiffs: [] });
      continue;
    }
    const fieldDiffs = diffSnapshots(a, b);
    if (fieldDiffs.length === 0) {
      same.push({ kind: 'same', md5, a, b, fieldDiffs: [] });
    } else {
      changed.push({ kind: 'changed', md5, a, b, fieldDiffs });
    }
  }
  for (const [md5, b] of mapB) {
    if (!mapA.has(md5)) {
      onlyB.push({ kind: 'only_b', md5, a: null, b, fieldDiffs: [] });
    }
  }

  const byName = (x: BomCompareItem, y: BomCompareItem) => {
    const na = (x.a?.fileName || x.b?.fileName || x.md5).toLowerCase();
    const nb = (y.a?.fileName || y.b?.fileName || y.md5).toLowerCase();
    return na.localeCompare(nb, 'zh-Hans-CN');
  };
  onlyA.sort(byName);
  onlyB.sort(byName);
  changed.sort(byName);
  same.sort(byName);

  return {
    onlyA,
    onlyB,
    changed,
    same,
    unalignedA,
    unalignedB,
    counts: {
      onlyA: onlyA.length,
      onlyB: onlyB.length,
      changed: changed.length,
      same: same.length,
      unalignedA: unalignedA.length,
      unalignedB: unalignedB.length,
    },
  };
}

export const BOM_COMPARE_KIND_LABEL: Record<BomCompareKind, string> = {
  only_a: '仅 A',
  only_b: '仅 B',
  changed: '变更',
  same: '相同',
};
