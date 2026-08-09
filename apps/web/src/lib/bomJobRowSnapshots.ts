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
import type { BomFeishuUploadJob } from './bomFeishuUploadJobs';
import { fetchBomScannerSettings, type BomJsonKeyMap } from './bomScannerSettings';
import { LABEL_EXTERNAL_ARTI, LABEL_INTERNAL_ARTI } from './bomUiLabels';

/** 与后台任务类型对应，用于详情里状态摘要的侧重点 */
export type BomJobDetailKind = 'it_download' | 'ext_sync' | 'feishu_upload';

export type BomJobRowDetailLine = {
  rowId: string;
  displayName: string;
  md5: string | null;
  localSizeLabel: string | null;
  statusLine: string;
  /** 本任务结果视角：fail / ok / skip / live */
  outcome?: 'fail' | 'ok' | 'skip' | 'live';
  /** 失败行当前是否已飞书对齐（补传后） */
  currentAligned?: boolean | null;
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
    const ie = st.it_fetch_error?.trim();
    const le = st.local_fetch_error?.trim();
    let part = `本地 ${st.local}`;
    if (ie) part += ` · ${LABEL_INTERNAL_ARTI} ${ie.slice(0, 140)}`;
    if (le) part += ` · ${le.slice(0, 140)}`;
    return part;
  }
  if (kind === 'ext_sync') {
    const ee = st.ext_fetch_error?.trim();
    return `${LABEL_EXTERNAL_ARTI} ${st.ext}${ee ? ` · ${ee.slice(0, 160)}` : ''}`;
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

/**
 * 飞书上传详情：优先读任务不可变 result（失败置顶），并附带当前行状态。
 * 旧任务无 result 时回退到 live bom_rows。
 */
export async function fetchFeishuUploadJobDetailLines(
  job: BomFeishuUploadJob,
): Promise<BomJobRowDetailLine[]> {
  const result = job.result;
  if (!result || (result.fail.length === 0 && result.ok.length === 0 && result.skip.length === 0)) {
    const live = await fetchBomJobRowDetails(job.batchId, job.rowIds, 'feishu_upload');
    return live.map((l) => ({ ...l, outcome: 'live' as const }));
  }

  const orderedIds = [
    ...result.fail.map((f) => f.rowId),
    ...result.ok.map((o) => o.rowId),
    ...result.skip.map((s) => s.rowId),
  ];
  const uniq = [...new Set(orderedIds.filter(Boolean))];
  const { jsonKeyMap } = await fetchBomScannerSettings();

  const { data, error } = await supabase
    .from('bom_rows')
    .select('id,bom_row,status')
    .eq('batch_id', job.batchId)
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

  const failMap = new Map(result.fail.map((f) => [f.rowId, f]));
  const okMap = new Map(result.ok.map((o) => [o.rowId, o]));
  const skipMap = new Map(result.skip.map((s) => [s.rowId, s]));

  const out: BomJobRowDetailLine[] = [];
  for (const id of orderedIds) {
    const r = byId.get(id);
    const fail = failMap.get(id);
    const ok = okMap.get(id);
    const skip = skipMap.get(id);
    const outcome: BomJobRowDetailLine['outcome'] = fail ? 'fail' : ok ? 'ok' : skip ? 'skip' : 'live';
    const displayFromSnap = fail?.fileName || ok?.fileName || null;
    const md5 = r ? extractExpectedMd5FromRow(r.bom_row, jsonKeyMap) : null;
    const localInfo = md5 ? localMap.get(md5) : undefined;
    const feishuNow = r?.status.feishu ?? null;
    const currentAligned = fail ? feishuNow === 'present' : null;

    let statusLine: string;
    if (fail) {
      statusLine = `本任务失败 · ${fail.error.slice(0, 200)}`;
      if (currentAligned) statusLine += ' · 当前已对齐（后续补传成功）';
      else if (feishuNow) statusLine += ` · 当前飞书 ${feishuNow}`;
    } else if (ok) {
      statusLine = `本任务成功${ok.kind === 'dedup' ? '（清单去重）' : ''}`;
      if (r) statusLine += ` · ${statusLineForKind('feishu_upload', r.status)}`;
    } else if (skip) {
      statusLine = `本任务跳过${skip.reason ? ` · ${skip.reason}` : ''}`;
    } else {
      statusLine = r ? statusLineForKind('feishu_upload', r.status) : '—';
    }

    out.push({
      rowId: id,
      displayName: displayFromSnap || (r ? displayNameForRow(r.bom_row, jsonKeyMap) : '—'),
      md5,
      localSizeLabel: localInfo != null ? formatBytesHuman(localInfo.sizeBytes) : null,
      statusLine,
      outcome,
      currentAligned,
    });
  }
  return out;
}
