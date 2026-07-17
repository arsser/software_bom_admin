import { supabase } from './supabase';
import { formatFunctionsInvokeError } from './supabaseFunctionsInvokeError';

export type BomFeishuVersionSheetJobStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export type BomFeishuVersionSheetJob = {
  id: string;
  batchId: string;
  status: BomFeishuVersionSheetJobStatus;
  triggerSource: string | null;
  message: string | null;
  sheetUrl: string | null;
  rowCount: number;
  requestedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
};

export type BomFeishuVersionSheetEnqueueResult =
  | {
      ok: true;
      async: true;
      jobId: string;
      batchId: string;
      message?: string;
      reused?: boolean;
    }
  | { ok: false; error: string };

function mapJob(raw: Record<string, unknown>): BomFeishuVersionSheetJob {
  return {
    id: String(raw.id),
    batchId: String(raw.batch_id),
    status: raw.status as BomFeishuVersionSheetJobStatus,
    triggerSource: raw.trigger_source != null ? String(raw.trigger_source) : null,
    message: (raw.message as string | null) ?? null,
    sheetUrl: (raw.sheet_url as string | null) ?? null,
    rowCount: Number(raw.row_count ?? 0),
    requestedAt: String(raw.requested_at),
    startedAt: raw.started_at ? String(raw.started_at) : null,
    finishedAt: raw.finished_at ? String(raw.finished_at) : null,
    createdAt: String(raw.created_at),
  };
}

const JOB_SELECT =
  'id,batch_id,status,trigger_source,message,sheet_url,row_count,requested_at,started_at,finished_at,created_at';

/** 入队：生成/覆盖版本目录下「软件包清单」飞书电子表格 */
export async function requestBomFeishuVersionSheet(batchId: string): Promise<BomFeishuVersionSheetEnqueueResult> {
  const { data, error } = await supabase.functions.invoke<Record<string, unknown>>('bom-feishu-version-sheet', {
    body: { batchId },
  });
  if (error) {
    return { ok: false, error: await formatFunctionsInvokeError(error) };
  }
  if (!data || typeof data !== 'object' || typeof data.ok !== 'boolean') {
    return { ok: false, error: '生成清单表请求返回格式异常' };
  }
  if (!data.ok) {
    return { ok: false, error: String(data.error ?? '入队失败') };
  }
  if (!data.jobId) {
    return { ok: false, error: '入队成功但未返回 jobId' };
  }
  return {
    ok: true,
    async: true,
    jobId: String(data.jobId),
    batchId: String(data.batchId ?? batchId),
    message: typeof data.message === 'string' ? data.message : undefined,
    reused: Boolean(data.reused),
  };
}

export async function fetchBomFeishuVersionSheetJobsForBatch(
  batchId: string,
  limit = 8,
): Promise<BomFeishuVersionSheetJob[]> {
  const { data, error } = await supabase
    .from('bom_feishu_version_sheet_jobs')
    .select(JOB_SELECT)
    .eq('batch_id', batchId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []).map((raw) => mapJob(raw as Record<string, unknown>));
}

export const BOM_FEISHU_VERSION_SHEET_JOB_STATUS_LABEL: Record<BomFeishuVersionSheetJobStatus, string> = {
  queued: '排队中',
  running: '生成中',
  succeeded: '已完成',
  failed: '失败',
};

export function feishuVersionSheetJobIsActive(status: BomFeishuVersionSheetJobStatus): boolean {
  return status === 'queued' || status === 'running';
}
