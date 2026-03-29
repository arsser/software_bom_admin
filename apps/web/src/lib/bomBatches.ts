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
import { isBomRowStatus, type BomRowStatus } from './bomRowStatus';

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
  status: BomRowStatus;
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

export async function fetchBomBatchById(batchId: string): Promise<Pick<BomBatch, 'id' | 'name' | 'productId' | 'headerOrder'> | null> {
  const { data, error } = await supabase
    .from('bom_batches')
    .select('id,name,product_id,header_order')
    .eq('id', batchId)
    .maybeSingle();
  if (error && error.code !== 'PGRST116') throw error;
  if (!data) return null;
  return {
    id: data.id as string,
    name: (data as any).name as string,
    productId: (data as any).product_id as string,
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

export async function fetchBomRows(batchId: string): Promise<BomBatchRow[]> {
  const { data, error } = await supabase
    .from('bom_rows')
    .select('id,bom_row,status')
    .eq('batch_id', batchId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data ?? []).map((raw: any) => ({
    id: String(raw.id),
    bom_row: raw.bom_row as BomRowRecord,
    status: isBomRowStatus(String(raw.status)) ? (String(raw.status) as BomRowStatus) : 'pending',
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

  const rowPayload = payload.rows.map((r) => ({ batch_id: batch.id, bom_row: r }));
  const { error: rowsError } = await supabase.from('bom_rows').insert(rowPayload);
  if (rowsError) throw rowsError;

  return batch.id as string;
}

export async function updateBomRowRecord(rowId: string, bom_row: BomRowRecord): Promise<void> {
  const { error } = await supabase.from('bom_rows').update({ bom_row }).eq('id', rowId);
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

  const payload = rows.map((r) => ({ batch_id: batchId, bom_row: r }));
  const { error: insertError } = await supabase.from('bom_rows').insert(payload);
  if (insertError) throw insertError;
}

export { buildBomWarnings, parsePastedBom };
export { parsePastedFromClipboard };
export { validateRequiredHeaders };
export type { BomRowRecord, BomWarning, HeaderValidationResult };
