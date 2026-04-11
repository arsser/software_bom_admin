import { supabase } from './supabase';
import {
  buildBomWarnings,
  parsePastedBom,
  parsePastedFromClipboard,
  validateRequiredHeaders,
  type BomRowRecord,
  type BomWarning,
  type HeaderValidationResult,
} from './bomParser';
import { mergeLocalFetchError, parseBomRowStatus, type BomRowStatusJson } from './bomRowStatus';

export type BomBatch = {
  id: string;
  name: string;
  productId: string;
  productName: string;
  headerOrder: string[];
  createdAt: string;
  rowCount: number;
};

export type BomBatchRow = {
  id: string;
  bom_row: BomRowRecord;
  /** JSONB：local / ext 及可选 local_fetch_error、ext_fetch_error */
  status: BomRowStatusJson;
};

export async function fetchBomBatches(): Promise<BomBatch[]> {
  const { data, error } = await supabase
    .from('bom_batches')
    .select('id,name,created_at,product_id,header_order,products(name),bom_rows(count)')
    .order('created_at', { ascending: false });

  if (error) throw error;

  return (data ?? []).map((item: any) => ({
    id: item.id as string,
    name: item.name as string,
    productId: item.product_id as string,
    productName: item.products?.name ?? '未知产品',
    headerOrder: Array.isArray(item.header_order) ? (item.header_order as string[]) : [],
    createdAt: item.created_at as string,
    rowCount: Number(item.bom_rows?.[0]?.count ?? 0),
  }));
}

export async function fetchBomBatchById(
  batchId: string,
): Promise<Pick<BomBatch, 'id' | 'name' | 'productId' | 'productName' | 'headerOrder'> | null> {
  const { data, error } = await supabase
    .from('bom_batches')
    .select('id,name,product_id,header_order,products(name)')
    .eq('id', batchId)
    .maybeSingle();
  if (error && error.code !== 'PGRST116') throw error;
  if (!data) return null;
  return {
    id: data.id as string,
    name: (data as any).name as string,
    productId: (data as any).product_id as string,
    productName: (data as any).products?.name ?? '未知产品',
    headerOrder: Array.isArray((data as any).header_order) ? (((data as any).header_order) as string[]) : [],
  };
}

export async function updateBomBatchHeaderOrder(batchId: string, headerOrder: string[]): Promise<void> {
  const { error } = await supabase
    .from('bom_batches')
    .update({ header_order: headerOrder })
    .eq('id', batchId);
  if (error) throw error;
}

export async function updateBomBatchMeta(batchId: string, payload: { name: string; productId?: string }): Promise<void> {
  const patch: { name: string; product_id?: string } = {
    name: payload.name.trim(),
  };
  if (payload.productId) patch.product_id = payload.productId;
  const { error } = await supabase
    .from('bom_batches')
    .update(patch)
    .eq('id', batchId);
  if (error) throw error;
}

export async function deleteBomBatch(batchId: string): Promise<void> {
  const { error } = await supabase.from('bom_batches').delete().eq('id', batchId);
  if (error) throw error;
}

/**
 * 按当前 local_file 索引重算该版本内行状态（与 worker 扫描结束时的规则一致，不含 synced_or_skipped）。
 * 用于网页加载/刷新时对齐，避免文件已从索引 prune 而 bom_rows 仍为校验通过。
 */
export async function refreshBomRowStatusesForBatch(batchId: string): Promise<number> {
  const { data, error } = await supabase.rpc('bom_refresh_local_found_statuses_for_batch', {
    p_batch_id: batchId,
  });
  if (error) throw error;
  if (typeof data === 'number' && Number.isFinite(data)) return data;
  if (typeof data === 'string' && data.trim() !== '') {
    const n = Number(data);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

export async function fetchBomRows(batchId: string): Promise<BomBatchRow[]> {
  const { data, error } = await supabase
    .from('bom_rows')
    .select('id,bom_row,status')
    .eq('batch_id', batchId)
    .order('sort_order', { ascending: true })
    .order('id', { ascending: true });
  if (error) throw error;
  return (data ?? []).map((raw: any) => ({
    id: String(raw.id),
    bom_row: raw.bom_row as BomRowRecord,
    status: parseBomRowStatus(raw.status),
  }));
}

export async function createBatchWithRows(payload: { name: string; productId: string; headerOrder: string[]; rows: BomRowRecord[] }): Promise<string> {
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError) throw authError;
  const userId = authData.user?.id;
  if (!userId) throw new Error('当前未登录，无法写入 BOM');

  const { data: batch, error: batchError } = await supabase
    .from('bom_batches')
    .insert({ name: payload.name.trim(), user_id: userId, product_id: payload.productId, header_order: payload.headerOrder })
    .select('id')
    .single();
  if (batchError) throw batchError;

  const rowPayload = payload.rows.map((r, idx) => ({
    batch_id: batch.id,
    bom_row: r,
    sort_order: idx,
  }));
  const { error: rowsError } = await supabase.from('bom_rows').insert(rowPayload);
  if (rowsError) throw rowsError;

  return batch.id as string;
}

export async function updateBomRowRecord(rowId: string, bom_row: BomRowRecord): Promise<void> {
  const { error } = await supabase.from('bom_rows').update({ bom_row }).eq('id', rowId);
  if (error) throw error;
}

/** 同时更新 bom_row 与 status.local_fetch_error（如「补全 MD5」写入状态说明·本地） */
export async function updateBomRowBomAndFetchError(
  rowId: string,
  bom_row: BomRowRecord,
  local_fetch_error: string | null,
): Promise<void> {
  const { data: row, error: selErr } = await supabase.from('bom_rows').select('status').eq('id', rowId).maybeSingle();
  if (selErr) throw selErr;
  const status = mergeLocalFetchError(parseBomRowStatus(row?.status), local_fetch_error);
  const { error } = await supabase.from('bom_rows').update({ bom_row, status }).eq('id', rowId);
  if (error) throw error;
}

export type LocalFileIndexInfo = {
  sizeBytes: number;
  /** 相对仓库根的路径（与 worker 一致） */
  path: string;
};

/** 按 MD5（小写 32 hex）查询本地索引中的 path、size_bytes；同 MD5 多文件时保留第一条命中 */
export async function fetchLocalFileInfoByMd5(md5List: string[]): Promise<Map<string, LocalFileIndexInfo>> {
  const unique = [
    ...new Set(md5List.filter((m) => /^[a-fA-F0-9]{32}$/.test(m.trim())).map((m) => m.trim().toLowerCase())),
  ];
  const map = new Map<string, LocalFileIndexInfo>();
  const chunkSize = 80;
  for (let i = 0; i < unique.length; i += chunkSize) {
    const part = unique.slice(i, i + chunkSize);
    const { data, error } = await supabase.from('local_file').select('md5,size_bytes,path').in('md5', part);
    if (error) throw error;
    for (const row of data ?? []) {
      const raw = row as { md5?: string; size_bytes?: number | string; path?: string };
      const m = String(raw.md5 ?? '').toLowerCase();
      const sz = typeof raw.size_bytes === 'string' ? Number(raw.size_bytes) : Number(raw.size_bytes);
      const p = String(raw.path ?? '').trim();
      if (/^[a-f0-9]{32}$/.test(m) && Number.isFinite(sz) && sz >= 0 && p && !map.has(m)) {
        map.set(m, { sizeBytes: sz, path: p });
      }
    }
  }
  return map;
}

export function mergeHeaderOrder(existing: string[], keysToEnsure: string[]): string[] {
  const seen = new Set(existing.map((h) => h.trim()));
  const out = [...existing];
  for (const k of keysToEnsure) {
    const t = k.trim();
    if (!t || seen.has(t)) continue;
    out.push(t);
    seen.add(t);
  }
  return out.slice(0, 64);
}

export async function replaceBatchRows(batchId: string, rows: BomRowRecord[]): Promise<void> {
  const { error: deleteError } = await supabase.from('bom_rows').delete().eq('batch_id', batchId);
  if (deleteError) throw deleteError;

  if (rows.length === 0) return;

  const payload = rows.map((r, idx) => ({ batch_id: batchId, bom_row: r, sort_order: idx }));
  const { error: insertError } = await supabase.from('bom_rows').insert(payload);
  if (insertError) throw insertError;
}

export { buildBomWarnings, parsePastedBom };
export { parsePastedFromClipboard };
export { validateRequiredHeaders };
export type { BomRowRecord, BomWarning, HeaderValidationResult };
