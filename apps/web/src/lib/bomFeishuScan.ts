import { supabase } from './supabase';

export type BomFeishuScanResult =
  | {
      ok: true;
      jobId: string;
      batchId: string;
      rows_total: number;
      rows_present: number;
      rows_absent: number;
      rows_error: number;
      message?: string;
    }
  | { ok: false; jobId?: string; error: string };

/** 调用 Edge Function：按当前 bom_scanner 规则扫描飞书目录并回写 bom_rows.status.feishu_*（不经 worker、不算 MD5） */
export async function requestBomFeishuScan(batchId: string): Promise<BomFeishuScanResult> {
  const { data, error } = await supabase.functions.invoke<BomFeishuScanResult>('bom-feishu-scan', {
    body: { batchId },
  });
  if (error) {
    return { ok: false, error: error.message || String(error) };
  }
  if (data && typeof data === 'object' && 'ok' in data) {
    return data as BomFeishuScanResult;
  }
  return { ok: false, error: '飞书扫描返回格式异常' };
}
