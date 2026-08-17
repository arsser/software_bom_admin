import { supabase } from './supabase';
import { formatSupabaseError } from './bomScannerJobs';
import { fetchProductDistributionSettings } from './products';
import { fetchBomFeishuVersionSheetJobsForBatch } from './bomFeishuVersionSheet';

export type SyncPipelinePhase =
  | 'idle'
  | 'enrich_md5'
  | 'download'
  | 'wait_verified'
  | 'ext_sync'
  | 'feishu_scan'
  | 'feishu_upload'
  | 'version_sheet'
  | 'done'
  | 'failed';

export const SYNC_PIPELINE_PHASE_LABEL: Record<SyncPipelinePhase, string> = {
  idle: '待命',
  enrich_md5: '补全 MD5',
  download: '拉取到本地',
  wait_verified: '等待本地校验',
  ext_sync: '同步 Artifactory-ext',
  feishu_scan: '扫描飞书目录',
  feishu_upload: '上传到飞书',
  version_sheet: '生成软件包清单',
  done: '已完成',
  failed: '失败',
};

export type SyncPipelineJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export type SyncPipelineJob = {
  id: string;
  batchId: string;
  rowIds: string[] | null;
  doExt: boolean;
  doFeishu: boolean;
  enrichMd5: boolean;
  status: SyncPipelineJobStatus;
  phase: string;
  lastMessage: string | null;
  currentChildJobId: string | null;
  currentChildKind: string | null;
  cancelRequested: boolean;
  startedAt: string | null;
  heartbeatAt: string | null;
  finishedAt: string | null;
  createdAt: string;
};

export type SyncPipelineProgress = {
  phase: SyncPipelinePhase;
  message: string;
  batchId?: string;
  batchName?: string;
  rowCount?: number;
  jobId?: string;
};

export type SyncPipelineOptions = {
  batchId: string;
  batchName: string;
  /** 本地拉取+校验始终执行 */
  doExt: boolean;
  doFeishu: boolean;
  /** 缺 MD5 时是否从 Artifactory 补全（默认 true） */
  enrichMd5?: boolean;
  /** 仅处理指定行；null/空数组表示整批 */
  rowIds?: string[] | null;
  signal?: AbortSignal;
  onProgress?: (p: SyncPipelineProgress) => void;
};

export type SyncPipelineResult = {
  batchId: string;
  batchName: string;
  rowCount: number;
  pipelineJobId: string;
  downloadJobId: string | null;
  extSyncJobId: string | null;
  feishuScanJobId: string | null;
  feishuUploadJobId: string | null;
  versionSheetJobId: string | null;
  versionSheetUrl: string | null;
};

const POLL_MS = 2000;

const PIPELINE_SELECT =
  'id,batch_id,row_ids,do_ext,do_feishu,enrich_md5,status,phase,last_message,current_child_job_id,current_child_kind,cancel_requested,started_at,heartbeat_at,finished_at,created_at';

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('已取消', 'AbortError'));
      return;
    }
    const t = setTimeout(() => resolve(), ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new DOMException('已取消', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function mapPipelineJob(raw: Record<string, unknown>): SyncPipelineJob {
  const rowIdsRaw = raw.row_ids;
  return {
    id: String(raw.id),
    batchId: String(raw.batch_id),
    rowIds: Array.isArray(rowIdsRaw) ? rowIdsRaw.map((x) => String(x)) : null,
    doExt: Boolean(raw.do_ext),
    doFeishu: Boolean(raw.do_feishu),
    enrichMd5: raw.enrich_md5 !== false,
    status: raw.status as SyncPipelineJobStatus,
    phase: String(raw.phase ?? 'queued'),
    lastMessage: (raw.last_message as string | null) ?? null,
    currentChildJobId: raw.current_child_job_id ? String(raw.current_child_job_id) : null,
    currentChildKind: raw.current_child_kind ? String(raw.current_child_kind) : null,
    cancelRequested: Boolean(raw.cancel_requested),
    startedAt: raw.started_at ? String(raw.started_at) : null,
    heartbeatAt: raw.heartbeat_at ? String(raw.heartbeat_at) : null,
    finishedAt: raw.finished_at ? String(raw.finished_at) : null,
    createdAt: String(raw.created_at),
  };
}

const KNOWN_PHASES: SyncPipelinePhase[] = [
  'idle',
  'enrich_md5',
  'download',
  'wait_verified',
  'ext_sync',
  'feishu_scan',
  'feishu_upload',
  'version_sheet',
  'done',
  'failed',
];

export function pipelineJobToPhase(job: SyncPipelineJob): SyncPipelinePhase {
  if (job.status === 'cancelled' || job.status === 'failed') return 'failed';
  if (job.status === 'succeeded') return 'done';
  if (job.status === 'queued') return 'idle';
  const p = job.phase as SyncPipelinePhase;
  if (KNOWN_PHASES.includes(p)) return p;
  return 'idle';
}

export function pipelineJobToProgress(
  job: SyncPipelineJob,
  extra?: { batchName?: string; rowCount?: number },
): SyncPipelineProgress {
  const phase = pipelineJobToPhase(job);
  const queuedMsg = '已入队，由后台 worker 编排。可关闭本页，进度见 BOM 任务页的子任务。';
  return {
    phase,
    message:
      job.lastMessage?.trim() ||
      (job.status === 'queued' ? queuedMsg : SYNC_PIPELINE_PHASE_LABEL[phase]),
    batchId: job.batchId,
    batchName: extra?.batchName,
    rowCount: extra?.rowCount ?? job.rowIds?.length,
    jobId: job.id,
  };
}

function friendlyPipelineError(err: unknown): Error {
  const raw = formatSupabaseError(err);
  if (/pipeline already active/i.test(raw)) {
    return new Error('该版本已有一键同步任务进行中，请等待结束或先取消');
  }
  if (/not authenticated/i.test(raw)) return new Error('未登录或登录已过期');
  if (/forbidden/i.test(raw)) return new Error('无权操作该版本');
  if (/invalid row_ids/i.test(raw)) return new Error('选中行不存在或不属于当前版本');
  return new Error(raw);
}

export function pipelineJobIsActive(status: string): boolean {
  return status === 'queued' || status === 'running';
}

export function pipelineJobIsTerminal(status: string): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

export async function requestBomSyncPipeline(input: {
  batchId: string;
  rowIds?: string[] | null;
  doExt: boolean;
  doFeishu: boolean;
  enrichMd5?: boolean;
}): Promise<string> {
  const ids = [...new Set((input.rowIds ?? []).map((id) => id.trim()).filter(Boolean))];
  const { data, error } = await supabase.rpc('bom_request_sync_pipeline', {
    p_batch_id: input.batchId.trim(),
    p_row_ids: ids.length > 0 ? ids : null,
    p_do_ext: Boolean(input.doExt),
    p_do_feishu: Boolean(input.doFeishu),
    p_enrich_md5: input.enrichMd5 !== false,
  });
  if (error) throw friendlyPipelineError(error);
  if (data == null) throw new Error('入队失败：未返回任务 ID');
  return String(data);
}

export async function fetchBomSyncPipelineJob(jobId: string): Promise<SyncPipelineJob | null> {
  const { data, error } = await supabase
    .from('bom_sync_pipeline_jobs')
    .select(PIPELINE_SELECT)
    .eq('id', jobId)
    .maybeSingle();
  if (error) throw new Error(formatSupabaseError(error));
  if (!data) return null;
  return mapPipelineJob(data as Record<string, unknown>);
}

export async function fetchLatestBomSyncPipelineJob(batchId: string): Promise<SyncPipelineJob | null> {
  const { data, error } = await supabase
    .from('bom_sync_pipeline_jobs')
    .select(PIPELINE_SELECT)
    .eq('batch_id', batchId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(formatSupabaseError(error));
  if (!data) return null;
  return mapPipelineJob(data as Record<string, unknown>);
}

export async function fetchActiveBomSyncPipelineJob(batchId: string): Promise<SyncPipelineJob | null> {
  const { data, error } = await supabase
    .from('bom_sync_pipeline_jobs')
    .select(PIPELINE_SELECT)
    .eq('batch_id', batchId)
    .in('status', ['queued', 'running'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(formatSupabaseError(error));
  if (!data) return null;
  return mapPipelineJob(data as Record<string, unknown>);
}

export async function cancelBomSyncPipelineJob(jobId: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('bom_cancel_sync_pipeline_job', { p_job_id: jobId });
  if (error) throw friendlyPipelineError(error);
  return Boolean(data);
}

function isRetriableWatchError(err: unknown): boolean {
  const raw = formatSupabaseError(err);
  const msg = raw.toLowerCase();
  return (
    msg.includes('failed to fetch') ||
    msg.includes('networkerror') ||
    msg.includes('network request failed') ||
    msg.includes('load failed') ||
    msg.includes('fetch failed') ||
    msg.includes('timeout') ||
    msg.includes('econnreset') ||
    msg.includes('econnrefused')
  );
}

export async function watchBomSyncPipeline(
  jobId: string,
  opts?: {
    signal?: AbortSignal;
    onProgress?: (p: SyncPipelineProgress) => void;
    batchName?: string;
    rowCount?: number;
  },
): Promise<SyncPipelineJob> {
  for (;;) {
    if (opts?.signal?.aborted) throw new DOMException('已取消', 'AbortError');
    try {
      const job = await fetchBomSyncPipelineJob(jobId);
      if (!job) throw new Error('流水线任务不存在');
      opts?.onProgress?.(pipelineJobToProgress(job, { batchName: opts.batchName, rowCount: opts.rowCount }));
      if (pipelineJobIsTerminal(job.status)) return job;
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') throw e;
      if (!isRetriableWatchError(e)) throw e;
      // 长任务期间浏览器/网关断连很常见，不把 Failed to fetch 当成流水线失败
    }
    await sleep(POLL_MS, opts?.signal);
  }
}

/**
 * 入队一键同步；若页面仍打开则轮询展示进度。关闭/刷新页面不会取消后台编排。
 */
export async function runBomSyncPipeline(input: SyncPipelineOptions): Promise<SyncPipelineResult> {
  const batchId = input.batchId.trim();
  const batchName = input.batchName.trim() || batchId;
  if (!batchId) throw new Error('缺少版本 ID');

  const doExt = Boolean(input.doExt);
  const doFeishu = Boolean(input.doFeishu);
  const enrichMd5 = input.enrichMd5 !== false;
  const rowIds = input.rowIds ?? null;
  const report = (p: SyncPipelineProgress) => input.onProgress?.(p);

  report({
    phase: 'idle',
    message: '正在入队一键同步…',
    batchId,
    batchName,
    rowCount: rowIds?.length,
  });

  const pipelineJobId = await requestBomSyncPipeline({
    batchId,
    rowIds,
    doExt,
    doFeishu,
    enrichMd5,
  });

  report({
    phase: 'idle',
    message: '已入队，由后台 worker 编排。可关闭本页，进度见 BOM 任务页的子任务。',
    batchId,
    batchName,
    rowCount: rowIds?.length,
    jobId: pipelineJobId,
  });

  const job = await watchBomSyncPipeline(pipelineJobId, {
    signal: input.signal,
    onProgress: report,
    batchName,
    rowCount: rowIds?.length,
  });

  if (job.status === 'cancelled') {
    throw new DOMException('已取消', 'AbortError');
  }
  if (job.status !== 'succeeded') {
    throw new Error(job.lastMessage?.trim() || '同步流水线失败');
  }

  let versionSheetUrl: string | null = null;
  let versionSheetJobId: string | null = null;
  if (doFeishu) {
    const sheets = await fetchBomFeishuVersionSheetJobsForBatch(batchId, 5);
    const latest = sheets[0];
    if (latest?.status === 'succeeded') {
      versionSheetJobId = latest.id;
      versionSheetUrl = latest.sheetUrl?.trim() || null;
    }
  }

  return {
    batchId,
    batchName,
    rowCount: rowIds?.length ?? 0,
    pipelineJobId,
    downloadJobId: job.currentChildKind === 'download' ? job.currentChildJobId : null,
    extSyncJobId: job.currentChildKind === 'ext_sync' ? job.currentChildJobId : null,
    feishuScanJobId: job.currentChildKind === 'feishu_scan' ? job.currentChildJobId : null,
    feishuUploadJobId: job.currentChildKind === 'feishu_upload' ? job.currentChildJobId : null,
    versionSheetJobId,
    versionSheetUrl,
  };
}

/** 校验产品分发配置是否满足勾选阶段 */
export async function assertPipelineDistributionReady(
  productId: string,
  opts: { doExt: boolean; doFeishu: boolean },
): Promise<void> {
  if (!opts.doExt && !opts.doFeishu) return;
  const dist = await fetchProductDistributionSettings(productId);
  if (opts.doExt && !dist.extArtifactoryRepo.trim()) {
    throw new Error('已勾选 Artifactory-ext：请先在产品中配置外部仓库');
  }
  if (opts.doFeishu && !dist.feishuDriveRootFolderToken.trim()) {
    throw new Error('已勾选飞书：请先在产品中配置飞书根目录');
  }
}
