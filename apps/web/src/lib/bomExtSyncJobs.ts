import { supabase } from './supabase';
import { formatBytesHuman } from './bytesFormat';
import { formatSupabaseError } from './bomScannerJobs';

export type BomExtSyncJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export type BomExtSyncJob = {
  id: string;
  batchId: string;
  rowIds: string[];
  batchName?: string | null;
  status: BomExtSyncJobStatus;
  progressCurrent: number;
  progressTotal: number;
  lastMessage: string | null;
  createdAt: string;
  finishedAt: string | null;
  startedAt: string | null;
  heartbeatAt: string | null;
  runningRowId: string | null;
  runningBytesDownloaded: number;
  runningBytesTotal: number | null;
  bytesDownloadedTotal: number;
  bytesTotal: number | null;
};

function numField(v: unknown): number {
  if (v == null) return 0;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function numOrNull(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function mapJob(raw: Record<string, unknown>, batchName?: string | null): BomExtSyncJob {
  const batches = raw.bom_batches as { name?: string } | null | undefined;
  const nameFromJoin = batches && typeof batches.name === 'string' ? batches.name : null;
  const rowIdsRaw = raw.row_ids;
  const rowIds = Array.isArray(rowIdsRaw) ? rowIdsRaw.map((x) => String(x)) : [];
  return {
    id: String(raw.id),
    batchId: String(raw.batch_id),
    rowIds,
    batchName: batchName ?? nameFromJoin,
    status: raw.status as BomExtSyncJobStatus,
    progressCurrent: Number(raw.progress_current ?? 0),
    progressTotal: Number(raw.progress_total ?? 0),
    lastMessage: (raw.last_message as string | null) ?? null,
    createdAt: String(raw.created_at),
    finishedAt: raw.finished_at ? String(raw.finished_at) : null,
    startedAt: raw.started_at ? String(raw.started_at) : null,
    heartbeatAt: raw.heartbeat_at ? String(raw.heartbeat_at) : null,
    runningRowId: raw.running_row_id ? String(raw.running_row_id) : null,
    runningBytesDownloaded: numField(raw.running_bytes_downloaded),
    runningBytesTotal: numOrNull(raw.running_bytes_total),
    bytesDownloadedTotal: numField(raw.bytes_downloaded_total),
    bytesTotal: numOrNull(raw.bytes_total),
  };
}

const JOB_SELECT =
  'id,batch_id,row_ids,status,progress_current,progress_total,last_message,created_at,finished_at,started_at,heartbeat_at,running_row_id,running_bytes_downloaded,running_bytes_total,bytes_downloaded_total,bytes_total';

/** 创建 ext 同步任务：p_row_ids 为空表示当前版本全部 eligible 行 */
export async function requestBomExtSync(batchId: string, rowIds?: string[] | null): Promise<string> {
  const { data, error } = await supabase.rpc('bom_request_ext_sync', {
    p_batch_id: batchId,
    p_row_ids: rowIds && rowIds.length > 0 ? rowIds : null,
  });
  if (error) {
    const msg = formatSupabaseError(error);
    if (/no eligible rows/i.test(msg)) {
      throw new Error(
        '没有可同步到 Artifactory-ext 的行（需本地校验通过且尚未写入 ext_url）。',
      );
    }
    throw new Error(msg || 'Artifactory-ext 同步入队失败');
  }
  if (data == null || typeof data !== 'string') throw new Error('bom_request_ext_sync 未返回任务 ID');
  return data;
}

/** 排队中立即取消；执行中则标记 cancel_requested；失败可关闭为 cancelled；已成功/已取消幂等 true */
export async function cancelBomExtSyncJob(jobId: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('bom_cancel_ext_sync_job', { p_job_id: jobId });
  if (error) throw error;
  return data === true;
}

export async function fetchBomExtSyncJobsForBatch(batchId: string, limit = 12): Promise<BomExtSyncJob[]> {
  const { data, error } = await supabase
    .from('bom_ext_sync_jobs')
    .select(JOB_SELECT)
    .eq('batch_id', batchId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []).map((raw) => mapJob(raw as Record<string, unknown>));
}

export type BomExtSyncJobListFilter = {
  batchId?: string | null;
  status?: BomExtSyncJobStatus | 'all' | null;
  limit?: number;
};

export async function fetchBomExtSyncJobsForUser(filter: BomExtSyncJobListFilter = {}): Promise<BomExtSyncJob[]> {
  const limit = filter.limit ?? 80;
  let q = supabase
    .from('bom_ext_sync_jobs')
    .select(`${JOB_SELECT},bom_batches(name)`)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (filter.batchId && filter.batchId.trim()) {
    q = q.eq('batch_id', filter.batchId.trim());
  }
  if (filter.status && filter.status !== 'all') {
    q = q.eq('status', filter.status);
  }
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []).map((raw) => mapJob(raw as Record<string, unknown>));
}

export const BOM_EXT_SYNC_JOB_STATUS_LABEL: Record<BomExtSyncJobStatus, string> = {
  queued: '排队中',
  running: '同步中',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

export function extSyncJobIsTerminal(status: BomExtSyncJobStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

export function extSyncJobProgressPercent(job: BomExtSyncJob): number {
  if (job.status === 'running' && job.runningBytesTotal != null && job.runningBytesTotal > 0) {
    return Math.min(100, (job.runningBytesDownloaded / job.runningBytesTotal) * 100);
  }
  if (job.bytesTotal != null && job.bytesTotal > 0) {
    return Math.min(100, (job.bytesDownloadedTotal / job.bytesTotal) * 100);
  }
  if (job.progressTotal > 0) {
    return Math.min(100, (job.progressCurrent / job.progressTotal) * 100);
  }
  return 0;
}

export function formatExtSyncJobBytesLine(job: BomExtSyncJob): string | null {
  if (job.status === 'running' && (job.runningBytesDownloaded > 0 || job.runningBytesTotal != null)) {
    const a = formatBytesHuman(job.runningBytesDownloaded);
    const b = job.runningBytesTotal != null ? formatBytesHuman(job.runningBytesTotal) : null;
    return b ? `当前文件 ${a} / ${b}` : `当前文件 ${a}`;
  }
  if (job.bytesDownloadedTotal > 0 || job.bytesTotal != null) {
    const a = formatBytesHuman(job.bytesDownloadedTotal);
    const b = job.bytesTotal != null ? formatBytesHuman(job.bytesTotal) : null;
    return b ? `累计 ${a} / ${b}` : `累计 ${a}`;
  }
  return null;
}
