import { supabase } from './supabase';
import type { BomRowRecord } from './bomParser';
import type { BomJsonKeyMap } from './bomScannerSettings';
import { parseBomRowStatus, type BomRowStatusJson } from './bomRowStatus';
import {
  extractComponentFromRow,
  extractDownloadUrlRaw,
  extractExpectedMd5FromRow,
  extractExtUrlFromRow,
  extractHttpUrlFromDownloadCell,
  extractModuleFromRow,
  fileBasename,
} from './bomRowFields';

export type BomSearchHit = {
  rowId: string;
  batchId: string;
  batchName: string;
  productId: string;
  productName: string;
  sortOrder: number;
  bomRow: BomRowRecord;
  status: BomRowStatusJson;
  createdAt: string;
  module: string;
  component: string;
  md5: string;
  fileName: string;
  downloadUrl: string;
  extUrl: string;
};

export type BomSearchParams = {
  query: string;
  productId?: string | null;
  batchIds?: string[] | null;
  limit?: number;
  offset?: number;
};

function asRecord(raw: unknown): BomRowRecord {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const out: BomRowRecord = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      out[k] = v == null ? '' : String(v);
    }
    return out;
  }
  return {};
}

function resolveFileName(bomRow: BomRowRecord, keyMap: BomJsonKeyMap): string {
  const dl = extractDownloadUrlRaw(bomRow, keyMap);
  const http = dl ? extractHttpUrlFromDownloadCell(dl) : null;
  if (http) {
    const base = fileBasename(http.split(/[?#]/)[0] ?? http);
    if (base) return base;
  }
  if (dl?.trim()) {
    const base = fileBasename(dl.trim());
    if (base) return base;
  }
  const feishuName = String(
    (bomRow as Record<string, unknown>).feishu_file_name ??
      (bomRow as Record<string, unknown>).file_name ??
      '',
  ).trim();
  return feishuName;
}

export function formatBomSearchHit(
  raw: {
    row_id: string;
    batch_id: string;
    batch_name: string;
    product_id: string;
    product_name: string;
    sort_order: number;
    bom_row: unknown;
    status: unknown;
    created_at: string;
  },
  keyMap: BomJsonKeyMap,
): BomSearchHit {
  const bomRow = asRecord(raw.bom_row);
  const downloadRaw = extractDownloadUrlRaw(bomRow, keyMap) ?? '';
  const downloadUrl = extractHttpUrlFromDownloadCell(downloadRaw) ?? downloadRaw.trim();
  const extRaw = extractExtUrlFromRow(bomRow, keyMap) ?? '';
  const extUrl = extractHttpUrlFromDownloadCell(extRaw) ?? extRaw.trim();
  return {
    rowId: String(raw.row_id),
    batchId: String(raw.batch_id),
    batchName: String(raw.batch_name ?? ''),
    productId: String(raw.product_id),
    productName: String(raw.product_name ?? ''),
    sortOrder: Number(raw.sort_order) || 0,
    bomRow,
    status: parseBomRowStatus(raw.status),
    createdAt: String(raw.created_at ?? ''),
    module: extractModuleFromRow(bomRow, keyMap) ?? '',
    component: extractComponentFromRow(bomRow, keyMap) ?? '',
    md5: extractExpectedMd5FromRow(bomRow, keyMap) ?? '',
    fileName: resolveFileName(bomRow, keyMap),
    downloadUrl,
    extUrl,
  };
}

/** 关键词至少 2 字符；单次最多 500 行（与 RPC 上限一致） */
export async function searchBomRows(
  params: BomSearchParams,
  keyMap: BomJsonKeyMap,
): Promise<BomSearchHit[]> {
  const q = params.query.trim();
  if (q.length < 2) {
    throw new Error('请输入至少 2 个字符的关键词');
  }
  const limit = Math.min(Math.max(params.limit ?? 100, 1), 500);
  const offset = Math.max(params.offset ?? 0, 0);
  const batchIds =
    params.batchIds && params.batchIds.length > 0 ? params.batchIds : null;

  const { data, error } = await supabase.rpc('bom_search_rows', {
    p_query: q,
    p_product_id: params.productId?.trim() || null,
    p_batch_ids: batchIds,
    p_limit: limit,
    p_offset: offset,
  });

  if (error) throw error;

  return (data ?? []).map((row: any) =>
    formatBomSearchHit(
      {
        row_id: row.row_id,
        batch_id: row.batch_id,
        batch_name: row.batch_name,
        product_id: row.product_id,
        product_name: row.product_name,
        sort_order: row.sort_order,
        bom_row: row.bom_row,
        status: row.status,
        created_at: row.created_at,
      },
      keyMap,
    ),
  );
}
