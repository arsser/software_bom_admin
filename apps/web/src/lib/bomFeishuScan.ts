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

export type BomFeishuScanOptions = {
  /** 根目录下无与当前版本名一致的文件夹时，调用飞书 create_folder 创建（名与 batchDir / safePathSegment 一致） */
  autoCreateVersionFolder?: boolean;
};

/** 调用 Edge Function：按当前 bom_scanner 规则扫描飞书目录并回写 bom_rows.status.feishu_*（不经 worker、不算 MD5） */
export async function requestBomFeishuScan(
  batchId: string,
  options?: BomFeishuScanOptions,
): Promise<BomFeishuScanResult> {
  const { data, error } = await supabase.functions.invoke<BomFeishuScanResult>('bom-feishu-scan', {
    body: {
      batchId,
      autoCreateVersionFolder: Boolean(options?.autoCreateVersionFolder),
    },
  });
  if (error) {
    return { ok: false, error: error.message || String(error) };
  }
  if (data && typeof data === 'object' && 'ok' in data) {
    return data as BomFeishuScanResult;
  }
  return { ok: false, error: '飞书扫描返回格式异常' };
}
