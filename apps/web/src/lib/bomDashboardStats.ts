import { supabase } from './supabase';
import { formatSupabaseError } from './bomScannerJobs';

export type BomDashboardStats = {
  bomBatchCount: number;
  bomRowCount: number;
  localFileCount: number;
  localDistinctMd5: number;
  localTotalBytes: number;
  rowsExtSynced: number;
};

export async function fetchBomDashboardStats(): Promise<BomDashboardStats> {
  const { data, error } = await supabase.rpc('bom_dashboard_stats');
  if (error) throw new Error(formatSupabaseError(error));
  const o = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  const n = (k: string) => {
    const v = o[k];
    if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
    if (typeof v === 'string' && v.trim() && /^-?\d+$/.test(v.trim())) return parseInt(v.trim(), 10);
    return 0;
  };
  const bytesRaw = o.local_total_bytes;
  let localTotalBytes = 0;
  if (typeof bytesRaw === 'number' && Number.isFinite(bytesRaw)) localTotalBytes = Math.max(0, Math.trunc(bytesRaw));
  else if (typeof bytesRaw === 'string' && /^\d+$/.test(bytesRaw.trim())) {
    const b = BigInt(bytesRaw.trim());
    const max = BigInt(Number.MAX_SAFE_INTEGER);
    localTotalBytes = b > max ? Number.MAX_SAFE_INTEGER : Number(b);
  }
  return {
    bomBatchCount: n('bom_batch_count'),
    bomRowCount: n('bom_row_count'),
    localFileCount: n('local_file_count'),
    localDistinctMd5: n('local_distinct_md5'),
    localTotalBytes,
    rowsExtSynced: n('rows_ext_synced'),
  };
}
