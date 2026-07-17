import { supabase } from './supabase';

export type BomFeishuManifestJobStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export type BomFeishuManifestJob = {
  id: string;
  productId: string;
  status: BomFeishuManifestJobStatus;
  triggerSource: string | null;
  message: string | null;
  filesTotal: number;
  filesWithMd5: number;
  filesWithoutMd5: number;
  requestedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  heartbeatAt: string | null;
  createdAt: string;
};

function mapJob(raw: Record<string, unknown>): BomFeishuManifestJob {
  return {
    id: String(raw.id),
    productId: String(raw.product_id),
    status: raw.status as BomFeishuManifestJobStatus,
    triggerSource: raw.trigger_source != null ? String(raw.trigger_source) : null,
    message: (raw.message as string | null) ?? null,
    filesTotal: Number(raw.files_total ?? 0),
    filesWithMd5: Number(raw.files_with_md5 ?? 0),
    filesWithoutMd5: Number(raw.files_without_md5 ?? 0),
    requestedAt: String(raw.requested_at),
    startedAt: raw.started_at ? String(raw.started_at) : null,
    finishedAt: raw.finished_at ? String(raw.finished_at) : null,
    heartbeatAt: raw.heartbeat_at ? String(raw.heartbeat_at) : null,
    createdAt: String(raw.created_at),
  };
}

const JOB_SELECT =
  'id,product_id,status,trigger_source,message,files_total,files_with_md5,files_without_md5,requested_at,started_at,finished_at,heartbeat_at,created_at';

export async function fetchBomFeishuManifestJobsForProduct(
  productId: string,
  limit = 12,
): Promise<BomFeishuManifestJob[]> {
  const { data, error } = await supabase
    .from('bom_feishu_manifest_jobs')
    .select(JOB_SELECT)
    .eq('product_id', productId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []).map((raw) => mapJob(raw as Record<string, unknown>));
}

export const BOM_FEISHU_MANIFEST_JOB_STATUS_LABEL: Record<BomFeishuManifestJobStatus, string> = {
  queued: '排队中',
  running: '扫描中',
  succeeded: '已完成',
  failed: '失败',
};

export function feishuManifestJobIsTerminal(status: BomFeishuManifestJobStatus): boolean {
  return status === 'succeeded' || status === 'failed';
}

export function feishuManifestJobIsActive(status: BomFeishuManifestJobStatus): boolean {
  return status === 'queued' || status === 'running';
}
