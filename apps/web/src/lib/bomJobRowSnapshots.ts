import { supabase } from './supabase';
import type { BomBatchRow } from './bomBatches';
import { fetchLocalFileInfoByMd5 } from './bomBatches';
import { formatBytesHuman } from './bytesFormat';
import type { BomRowRecord } from './bomParser';
import {
  extractDownloadUrlRaw,
  extractExpectedMd5FromRow,
  extractExtUrlFromRow,
  extractHttpUrlFromDownloadCell,
} from './bomRowFields';
import { parseBomRowStatus, type BomRowStatusJson } from './bomRowStatus';
import { fetchBomScannerSettings, type BomJsonKeyMap } from './bomScannerSettings';

/** 与后台任务类型对应，用于详情里状态摘要的侧重点 */
export type BomJobDetailKind = 'it_download' | 'ext_sync' | 'feishu_upload';

export type BomJobRowDetailLine = {
  rowId: string;
  displayName: string;
  md5: string | null;
  localSizeLabel: string | null;
  statusLine: string;
};

function urlBasename(u: string): string {
  try {
    const p = new URL(u).pathname;
    const seg = p.split('/').filter(Boolean);
    if (seg.length === 0) return u;
    return decodeURIComponent(seg[seg.length - 1]!);
  } catch {
    return u;
  }
}

function displayNameForRow(row: BomRowRecord, keyMap: BomJsonKeyMap): string {
  const du = extractDownloadUrlRaw(row, keyMap);
  const http = du ? extractHttpUrlFromDownloadCell(du) : null;
  if (http) {
    const b = urlBasename(http);
    if (b) return b;
  }
  const ext = extractExtUrlFromRow(row, keyMap)?.trim();
  if (ext && /^https?:\/\//i.test(ext)) {
    const b = urlBasename(ext);
    if (b) return b;
  }
  return '—';
}

function statusLineForKind(kind: BomJobDetailKind, st: BomRowStatusJson): string {
  if (kind === 'it_download') {
    const le = st.local_fetch_error?.trim();
    return `本地 ${st.local}${le ? ` · ${le.slice(0, 160)}` : ''}`;
  }
  if (kind === 'ext_sync') {
    const ee = st.ext_fetch_error?.trim();
    return `ext ${st.ext}${ee ? ` · ${ee.slice(0, 160)}` : ''}`;
  }
  const f = st.feishu ?? 'not_scanned';
  const fe = st.feishu_scan_error?.trim();
  const fn = st.feishu_file_name?.trim();
  const sz = st.feishu_size_bytes;
  let part = `飞书 ${f}`;
  if (fn) part += ` · ${fn}`;
  if (sz != null && Number.isFinite(Number(sz))) part += ` · ${formatBytesHuman(Number(sz))}`;
  if (fe) part += ` · ${fe.slice(0, 160)}`;
  return part;
}

/**
 * 按任务 row_ids 顺序，从 bom_rows + local_file（按期望 MD5）组装行级快照，供任务详情弹窗展示。
 */
export async function fetchBomJobRowDetails(
  batchId: string,
  rowIds: string[],
  kind: BomJobDetailKind,
): Promise<BomJobRowDetailLine[]> {
  const ordered = rowIds.map((id) => String(id).trim()).filter(Boolean);
  const uniq = [...new Set(ordered)];
  if (uniq.length === 0) return [];

  const { jsonKeyMap } = await fetchBomScannerSettings();

  const { data, error } = await supabase
    .from('bom_rows')
    .select('id,bom_row,status')
    .eq('batch_id', batchId)
    .in('id', uniq);
  if (error) throw error;

  const byId = new Map<string, BomBatchRow>();
  for (const raw of data ?? []) {
    const rec = raw as Record<string, unknown>;
    byId.set(String(rec.id), {
      id: String(rec.id),
      bom_row: rec.bom_row as BomRowRecord,
      status: parseBomRowStatus(rec.status),
    });
  }

  const md5List: string[] = [];
  for (const id of uniq) {
    const r = byId.get(id);
    if (!r) continue;
    const m = extractExpectedMd5FromRow(r.bom_row, jsonKeyMap);
    if (m) md5List.push(m);
  }
  const localMap = await fetchLocalFileInfoByMd5(md5List);

  const out: BomJobRowDetailLine[] = [];
  for (const id of ordered) {
    const r = byId.get(id);
    if (!r) {
      out.push({
        rowId: id,
        displayName: '（行不存在或无权访问）',
        md5: null,
        localSizeLabel: null,
        statusLine: '—',
      });
      continue;
    }
    const md5 = extractExpectedMd5FromRow(r.bom_row, jsonKeyMap);
    const localInfo = md5 ? localMap.get(md5) : undefined;
    const localSizeLabel = localInfo != null ? formatBytesHuman(localInfo.sizeBytes) : null;
    out.push({
      rowId: id,
      displayName: displayNameForRow(r.bom_row, jsonKeyMap),
      md5,
      localSizeLabel,
      statusLine: statusLineForKind(kind, r.status),
    });
  }
  return out;
}
