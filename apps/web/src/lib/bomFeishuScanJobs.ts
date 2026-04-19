import { supabase } from './supabase';

export type BomFeishuScanJobStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export type BomFeishuScanJob = {
  id: string;
  batchId: string;
  status: BomFeishuScanJobStatus;
  triggerSource: string | null;
  message: string | null;
  rowsTotal: number;
  rowsPresent: number;
  rowsAbsent: number;
  rowsError: number;
  requestedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  autoCreateVersionFolder: boolean;
};

function mapJob(raw: Record<string, unknown>): BomFeishuScanJob {
  return {
    id: String(raw.id),
    batchId: String(raw.batch_id),
    status: raw.status as BomFeishuScanJobStatus,
    triggerSource: raw.trigger_source != null ? String(raw.trigger_source) : null,
    message: (raw.message as string | null) ?? null,
    rowsTotal: Number(raw.rows_total ?? 0),
    rowsPresent: Number(raw.rows_present ?? 0),
    rowsAbsent: Number(raw.rows_absent ?? 0),
    rowsError: Number(raw.rows_error ?? 0),
    requestedAt: String(raw.requested_at),
    startedAt: raw.started_at ? String(raw.started_at) : null,
    finishedAt: raw.finished_at ? String(raw.finished_at) : null,
    createdAt: String(raw.created_at),
    autoCreateVersionFolder: Boolean(raw.auto_create_version_folder),
  };
}

const JOB_SELECT =
  'id,batch_id,status,trigger_source,message,rows_total,rows_present,rows_absent,rows_error,requested_at,started_at,finished_at,created_at,auto_create_version_folder';

export async function fetchBomFeishuScanJobsForBatch(batchId: string, limit = 20): Promise<BomFeishuScanJob[]> {
  const { data, error } = await supabase
    .from('bom_feishu_scan_jobs')
    .select(JOB_SELECT)
    .eq('batch_id', batchId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []).map((raw) => mapJob(raw as Record<string, unknown>));
}

export const BOM_FEISHU_SCAN_JOB_STATUS_LABEL: Record<BomFeishuScanJobStatus, string> = {
  queued: '排队中',
  running: '扫描中',
  succeeded: '已完成',
  failed: '失败',
};

export function feishuScanJobIsTerminal(status: BomFeishuScanJobStatus): boolean {
  return status === 'succeeded' || status === 'failed';
}

/** 用行计数估算进度（对账阶段会更新 rows_*） */
export function feishuScanJobProgressPercent(job: BomFeishuScanJob): number {
  const t = job.rowsTotal;
  if (t <= 0) return 0;
  const done = Math.min(t, job.rowsPresent + job.rowsAbsent + job.rowsError);
  return Math.min(100, (done / t) * 100);
}
