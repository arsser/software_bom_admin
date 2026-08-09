import { supabase } from './supabase';
import { formatBytesHuman } from './bytesFormat';
import { formatSupabaseError } from './bomScannerJobs';

export type BomFeishuUploadJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export type BomFeishuUploadJobResultFail = {
  rowId: string;
  fileName?: string;
  error: string;
  at?: string;
};

export type BomFeishuUploadJobResultOk = {
  rowId: string;
  fileName?: string;
  kind?: string;
};

export type BomFeishuUploadJobResultSkip = {
  rowId: string;
  reason?: string;
};

export type BomFeishuUploadJobResult = {
  ok: BomFeishuUploadJobResultOk[];
  fail: BomFeishuUploadJobResultFail[];
  skip: BomFeishuUploadJobResultSkip[];
  counts?: {
    ok?: number;
    fail?: number;
    skip?: number;
    dedup?: number;
    row_retries?: number;
  };
  finished_at?: string;
};

export type BomFeishuUploadJob = {
  id: string;
  batchId: string;
  rowIds: string[];
  batchName?: string | null;
  status: BomFeishuUploadJobStatus;
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
  result: BomFeishuUploadJobResult | null;
  parentJobId: string | null;
  /** 指向本任务的补传任务 id（列表查询时附带） */
  childJobIds?: string[];
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

function parseResult(raw: unknown): BomFeishuUploadJobResult | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const failRaw = Array.isArray(o.fail) ? o.fail : [];
  const okRaw = Array.isArray(o.ok) ? o.ok : [];
  const skipRaw = Array.isArray(o.skip) ? o.skip : [];
  return {
    ok: okRaw
      .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
      .map((x) => ({
        rowId: String(x.rowId ?? ''),
        fileName: typeof x.fileName === 'string' ? x.fileName : undefined,
        kind: typeof x.kind === 'string' ? x.kind : undefined,
      }))
      .filter((x) => x.rowId),
    fail: failRaw
      .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
      .map((x) => ({
        rowId: String(x.rowId ?? ''),
        fileName: typeof x.fileName === 'string' ? x.fileName : undefined,
        error: String(x.error ?? ''),
        at: typeof x.at === 'string' ? x.at : undefined,
      }))
      .filter((x) => x.rowId),
    skip: skipRaw
      .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
      .map((x) => ({
        rowId: String(x.rowId ?? ''),
        reason: typeof x.reason === 'string' ? x.reason : undefined,
      }))
      .filter((x) => x.rowId),
    counts:
      o.counts && typeof o.counts === 'object' && !Array.isArray(o.counts)
        ? (o.counts as BomFeishuUploadJobResult['counts'])
        : undefined,
    finished_at: typeof o.finished_at === 'string' ? o.finished_at : undefined,
  };
}

function mapJob(raw: Record<string, unknown>, batchName?: string | null): BomFeishuUploadJob {
  const batches = raw.bom_batches as { name?: string } | null | undefined;
  const nameFromJoin = batches && typeof batches.name === 'string' ? batches.name : null;
  const rowIdsRaw = raw.row_ids;
  const rowIds = Array.isArray(rowIdsRaw) ? rowIdsRaw.map((x) => String(x)) : [];
  return {
    id: String(raw.id),
    batchId: String(raw.batch_id),
    rowIds,
    batchName: batchName ?? nameFromJoin,
    status: raw.status as BomFeishuUploadJobStatus,
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
    result: parseResult(raw.result),
    parentJobId: raw.parent_job_id ? String(raw.parent_job_id) : null,
  };
}

const JOB_SELECT =
  'id,batch_id,row_ids,status,progress_current,progress_total,last_message,created_at,finished_at,started_at,heartbeat_at,running_row_id,running_bytes_downloaded,running_bytes_total,bytes_downloaded_total,bytes_total,result,parent_job_id';

/** 创建飞书上传任务：p_row_ids 为空表示当前版本全部 eligible 行；补传可传 parentJobId */
export async function requestBomFeishuUpload(
  batchId: string,
  rowIds?: string[] | null,
  parentJobId?: string | null,
): Promise<string> {
  const payload: Record<string, unknown> = {
    p_batch_id: batchId,
    p_row_ids: rowIds && rowIds.length > 0 ? rowIds : null,
  };
  if (parentJobId) payload.p_parent_job_id = parentJobId;
  const { data, error } = await supabase.rpc('bom_request_feishu_upload', payload);
  if (error) {
    const msg = formatSupabaseError(error);
    if (/no eligible rows/i.test(msg)) {
      throw new Error(
        '没有可上传到飞书的行（需本地校验通过，且飞书扫描为「不存在/错误」；若飞书已存在该文件则会跳过）。',
      );
    }
    throw new Error(msg || '飞书上传入队失败');
  }
  if (data == null || typeof data !== 'string') throw new Error('bom_request_feishu_upload 未返回任务 ID');
  return data;
}

/** 仅重试某任务 result.fail 中仍 eligible 的行，并挂 parent_job_id */
export async function requestBomFeishuUploadRetryFailed(parentJob: BomFeishuUploadJob): Promise<string> {
  const failIds = (parentJob.result?.fail ?? []).map((f) => f.rowId).filter(Boolean);
  if (failIds.length === 0) {
    throw new Error('该任务没有可补传的失败行快照（result.fail 为空；可能是旧任务）');
  }
  return requestBomFeishuUpload(parentJob.batchId, failIds, parentJob.id);
}

export async function cancelBomFeishuUploadJob(jobId: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('bom_cancel_feishu_upload_job', { p_job_id: jobId });
  if (error) throw error;
  return data === true;
}

function attachChildJobIds(jobs: BomFeishuUploadJob[]): BomFeishuUploadJob[] {
  const childrenByParent = new Map<string, string[]>();
  for (const j of jobs) {
    if (!j.parentJobId) continue;
    const list = childrenByParent.get(j.parentJobId) ?? [];
    list.push(j.id);
    childrenByParent.set(j.parentJobId, list);
  }
  return jobs.map((j) => ({
    ...j,
    childJobIds: childrenByParent.get(j.id) ?? [],
  }));
}

export async function fetchBomFeishuUploadJobsForBatch(batchId: string, limit = 12): Promise<BomFeishuUploadJob[]> {
  const { data, error } = await supabase
    .from('bom_feishu_upload_jobs')
    .select(JOB_SELECT)
    .eq('batch_id', batchId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return attachChildJobIds((data ?? []).map((raw) => mapJob(raw as Record<string, unknown>)));
}

export type BomFeishuUploadJobListFilter = {
  batchId?: string | null;
  status?: BomFeishuUploadJobStatus | 'all' | null;
  limit?: number;
};

export async function fetchBomFeishuUploadJobsForUser(
  filter: BomFeishuUploadJobListFilter = {},
): Promise<BomFeishuUploadJob[]> {
  const limit = filter.limit ?? 80;
  let q = supabase
    .from('bom_feishu_upload_jobs')
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
  return attachChildJobIds((data ?? []).map((raw) => mapJob(raw as Record<string, unknown>)));
}

export const BOM_FEISHU_UPLOAD_JOB_STATUS_LABEL: Record<BomFeishuUploadJobStatus, string> = {
  queued: '排队中',
  running: '上传中',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

export function feishuUploadJobIsTerminal(status: BomFeishuUploadJobStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

export function feishuUploadJobFailCount(job: BomFeishuUploadJob): number {
  if (job.result?.counts?.fail != null && Number.isFinite(job.result.counts.fail)) {
    return Math.max(0, Number(job.result.counts.fail));
  }
  if (job.result?.fail?.length) return job.result.fail.length;
  const m = job.lastMessage?.match(/失败\s*(\d+)/);
  if (m) return Number(m[1]);
  return 0;
}

export function feishuUploadJobProgressPercent(job: BomFeishuUploadJob): number {
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

export function formatFeishuUploadJobBytesLine(job: BomFeishuUploadJob): string | null {
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
