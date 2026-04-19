import { supabase } from './supabase';

/** Edge 入队成功：前端轮询 bom_feishu_scan_jobs 直至终态 */
export type BomFeishuScanEnqueued = {
  ok: true;
  async: true;
  jobId: string;
  batchId: string;
  rows_total: number;
  message?: string;
};

/** 同步完成（旧版 Edge；当前实现仅返回入队形态） */
export type BomFeishuScanCompleted = {
  ok: true;
  jobId: string;
  batchId: string;
  rows_total: number;
  rows_present: number;
  rows_absent: number;
  rows_error: number;
  message?: string;
};

export type BomFeishuScanResult = BomFeishuScanEnqueued | BomFeishuScanCompleted | { ok: false; jobId?: string; error: string };

export type BomFeishuScanOptions = {
  /** 根目录下无与当前版本名一致的文件夹时，调用飞书 create_folder 创建（名与 batchDir / safePathSegment 一致） */
  autoCreateVersionFolder?: boolean;
};

/** 调用 Edge Function：校验并入队 bom_feishu_scan_jobs，由 bom-scanner-worker 执行扫描与回写 bom_rows.status.feishu_* */
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
