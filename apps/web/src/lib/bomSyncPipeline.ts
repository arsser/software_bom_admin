import {
  fetchBomBatchById,
  fetchBomRows,
  fetchLocalFileInfoByMd5,
  mergeHeaderOrder,
  refreshBomRowStatusesForBatch,
  updateBomBatchHeaderOrder,
  updateBomRowBomAndStatusFetchErrors,
  type BomBatchRow,
} from './bomBatches';
import { enrichBomRowsFromArtifactory } from './bomArtifactoryEnrich';
import { fetchArtifactorySettings } from './artifactorySettings';
import {
  downloadJobIsTerminal,
  fetchBomDownloadJobsForBatch,
  requestBomItDownload,
  type BomDownloadJob,
} from './bomDownloadJobs';
import {
  extSyncJobIsTerminal,
  fetchBomExtSyncJobsForBatch,
  requestBomExtSync,
  type BomExtSyncJob,
} from './bomExtSyncJobs';
import { requestBomFeishuScan } from './bomFeishuScan';
import {
  fetchBomFeishuScanJobsForBatch,
  feishuScanJobIsTerminal,
  type BomFeishuScanJob,
} from './bomFeishuScanJobs';
import {
  fetchBomFeishuUploadJobsForBatch,
  feishuUploadJobIsTerminal,
  requestBomFeishuUpload,
  type BomFeishuUploadJob,
} from './bomFeishuUploadJobs';
import {
  fetchBomFeishuVersionSheetJobsForBatch,
  feishuVersionSheetJobIsActive,
  requestBomFeishuVersionSheet,
  type BomFeishuVersionSheetJob,
} from './bomFeishuVersionSheet';
import {
  extractComponentFromRow,
  extractDownloadUrlRaw,
  extractExpectedMd5FromRow,
  extractExtUrlFromRow,
  extractHttpUrlFromDownloadCell,
  rowEligibleForExtSync,
  rowEligibleForItPull,
  rowExtUiComplete,
} from './bomRowFields';
import type { BomJsonKeyMap, BomScannerConfig } from './bomScannerSettings';
import { fetchBomScannerSettings } from './bomScannerSettings';
import { fetchProductDistributionSettings } from './products';
import { feishuScanErrorBlocksFeishuUpload } from './bomRowStatus';
import {
  computeJobTransferLiveStats,
  jobEffectiveTransferredBytes,
  type BomJobByteProgress,
} from './bomJobTransferStats';
import {
  buildJobEndNotifyText,
  buildJobProgressNotifyText,
  buildPipelineDoneNotifyText,
  buildPipelineSkipNotifyText,
  sendFeishuNotify,
  type PipelineNotifyStepOpts,
} from './feishuNotify';

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
  downloadJobId: string | null;
  extSyncJobId: string | null;
  feishuScanJobId: string | null;
  feishuUploadJobId: string | null;
  versionSheetJobId: string | null;
  versionSheetUrl: string | null;
};

const POLL_MS = 2000;
const VERIFY_TIMEOUT_MS = 10 * 60 * 1000;
/** 字节进度达到该比例发「进行中」通知（合并原开始通知） */
const PROGRESS_NOTIFY_RATIO = 0.01;
/** 不足 1% 时的兜底：运行超过该毫秒仍发一条进度通知 */
const PROGRESS_NOTIFY_FALLBACK_MS = 60_000;

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

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('已取消', 'AbortError');
}

function jobStartedAtMs(startedAt: string | null | undefined): number | null {
  if (!startedAt) return null;
  const t = Date.parse(startedAt);
  return Number.isFinite(t) ? t : null;
}

function elapsedSecSince(startedAt: string | null | undefined, finishedAt?: string | null): number | null {
  const start = jobStartedAtMs(startedAt);
  if (start == null) return null;
  const end = finishedAt ? Date.parse(finishedAt) : Date.now();
  if (!Number.isFinite(end) || end < start) return null;
  return (end - start) / 1000;
}

type ByteJobLike = BomJobByteProgress & {
  id: string;
  status: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  lastMessage?: string | null;
  message?: string | null;
};

async function pollByteJobWithNotify<T extends ByteJobLike>(opts: {
  label: string;
  batchName: string;
  signal?: AbortSignal;
  fetchOne: () => Promise<T | null>;
  isDone: (v: T) => boolean;
  /** 飞书上传进度字段已含当前文件 */
  runningAlreadyInTotal: boolean;
  /** 失败时是否由前端发结束通知（默认 false，交给 Worker） */
  notifyFailure?: boolean;
  step?: PipelineNotifyStepOpts;
}): Promise<T> {
  let sample: { t: number; bytes: number; speedBps: number | null } | undefined;
  let progressNotified = false;
  const watchStarted = Date.now();

  for (;;) {
    throwIfAborted(opts.signal);
    const v = await opts.fetchOne();
    if (v != null) {
      if (v.status === 'running' || opts.isDone(v)) {
        const nowMs = Date.now();
        const byteJob: BomJobByteProgress = {
          status: v.status,
          bytesDownloadedTotal: v.bytesDownloadedTotal,
          bytesTotal: v.bytesTotal,
          runningBytesDownloaded: v.runningBytesDownloaded,
          runningBytesTotal: v.runningBytesTotal,
          progressCurrent: v.progressCurrent,
          progressTotal: v.progressTotal,
          startedAtMs: jobStartedAtMs(v.startedAt),
        };
        const { stats, nextSample } = computeJobTransferLiveStats(
          byteJob,
          opts.runningAlreadyInTotal,
          sample,
          nowMs,
        );
        sample = nextSample;

        if (!progressNotified && v.status === 'running') {
          const transferred = jobEffectiveTransferredBytes(byteJob, opts.runningAlreadyInTotal);
          const total = v.bytesTotal;
          const ratio = total != null && total > 0 ? transferred / total : 0;
          const rowRatio =
            (v.progressTotal ?? 0) > 0 ? (v.progressCurrent ?? 0) / (v.progressTotal as number) : 0;
          const hitPct = ratio >= PROGRESS_NOTIFY_RATIO || rowRatio >= PROGRESS_NOTIFY_RATIO;
          const fallback =
            !hitPct &&
            nowMs - watchStarted >= PROGRESS_NOTIFY_FALLBACK_MS &&
            (transferred > 0 || (v.progressCurrent ?? 0) > 0 || (total != null && total > 0));
          if (hitPct || fallback) {
            progressNotified = true;
            const pct =
              total != null && total > 0
                ? Math.min(100, (transferred / total) * 100)
                : rowRatio * 100;
            await sendFeishuNotify(
              buildJobProgressNotifyText({
                title: `${opts.label}进行中`,
                batchName: opts.batchName,
                jobId: v.id,
                progressPct: pct,
                bytesTotal: total,
                bytesDone: transferred,
                speedBps: stats.speedBps,
                etaSec: stats.etaSec,
                progressCurrent: v.progressCurrent,
                progressTotal: v.progressTotal,
                extra: fallback && !hitPct ? '（进度不足 1%，超时兜底通知）' : undefined,
                ...opts.step,
              }),
            );
          }
        }

        if (opts.isDone(v)) {
          const ok = v.status === 'succeeded';
          if (ok || opts.notifyFailure) {
            const elapsed = elapsedSecSince(v.startedAt, v.finishedAt);
            const transferred = jobEffectiveTransferredBytes(byteJob, opts.runningAlreadyInTotal);
            const avgSpeed =
              elapsed != null && elapsed > 0 && transferred > 0 ? transferred / elapsed : null;
            await sendFeishuNotify(
              buildJobEndNotifyText({
                title: opts.label,
                batchName: opts.batchName,
                jobId: v.id,
                ok,
                elapsedSec: elapsed,
                bytesTotal: v.bytesTotal,
                avgSpeedBps: avgSpeed,
                detail: (v.lastMessage || v.message || '').trim() || undefined,
                ...opts.step,
              }),
            );
          }
          return v;
        }
      }
    }
    await sleep(POLL_MS, opts.signal);
  }
}

async function pollSimpleJobWithNotify<T extends { id: string; status: string; startedAt?: string | null; finishedAt?: string | null; message?: string | null; lastMessage?: string | null }>(opts: {
  label: string;
  batchName: string;
  signal?: AbortSignal;
  fetchOne: () => Promise<T | null>;
  isDone: (v: T) => boolean;
  isSuccess: (v: T) => boolean;
  step?: PipelineNotifyStepOpts;
}): Promise<T> {
  let progressNotified = false;
  for (;;) {
    throwIfAborted(opts.signal);
    const v = await opts.fetchOne();
    if (v != null) {
      if (!progressNotified && v.status === 'running') {
        progressNotified = true;
        await sendFeishuNotify(
          buildJobProgressNotifyText({
            title: `${opts.label}进行中`,
            batchName: opts.batchName,
            jobId: v.id,
            extra: '（无字节进度，任务已开始）',
            ...opts.step,
          }),
        );
      }
      if (opts.isDone(v)) {
        if (opts.isSuccess(v)) {
          await sendFeishuNotify(
            buildJobEndNotifyText({
              title: opts.label,
              batchName: opts.batchName,
              jobId: v.id,
              ok: true,
              elapsedSec: elapsedSecSince(v.startedAt, v.finishedAt),
              detail: (v.message || v.lastMessage || '').trim() || undefined,
              ...opts.step,
            }),
          );
        }
        return v;
      }
    }
    await sleep(POLL_MS, opts.signal);
  }
}

async function waitDownloadJob(
  batchId: string,
  jobId: string,
  batchName: string,
  signal?: AbortSignal,
  step?: PipelineNotifyStepOpts,
): Promise<BomDownloadJob> {
  const job = await pollByteJobWithNotify({
    label: '本地拉取',
    batchName,
    signal,
    step,
    runningAlreadyInTotal: false,
    fetchOne: async () => {
      const jobs = await fetchBomDownloadJobsForBatch(batchId, 20);
      return jobs.find((j) => j.id === jobId) ?? null;
    },
    isDone: (j) => downloadJobIsTerminal(j.status),
  });
  if (job.status !== 'succeeded') {
    throw new Error(`本地拉取失败：${job.lastMessage?.trim() || job.status}`);
  }
  return job;
}

async function waitExtSyncJob(
  batchId: string,
  jobId: string,
  batchName: string,
  signal?: AbortSignal,
  step?: PipelineNotifyStepOpts,
): Promise<BomExtSyncJob> {
  const job = await pollByteJobWithNotify({
    label: 'Artifactory-ext 同步',
    batchName,
    signal,
    step,
    runningAlreadyInTotal: false,
    fetchOne: async () => {
      const jobs = await fetchBomExtSyncJobsForBatch(batchId, 20);
      return jobs.find((j) => j.id === jobId) ?? null;
    },
    isDone: (j) => extSyncJobIsTerminal(j.status),
  });
  if (job.status !== 'succeeded') {
    throw new Error(`Artifactory-ext 同步失败：${job.lastMessage?.trim() || job.status}`);
  }
  return job;
}

async function waitFeishuScanJob(
  batchId: string,
  jobId: string,
  batchName: string,
  signal?: AbortSignal,
  step?: PipelineNotifyStepOpts,
): Promise<BomFeishuScanJob> {
  const job = await pollSimpleJobWithNotify({
    label: '飞书扫描',
    batchName,
    signal,
    step,
    fetchOne: async () => {
      const jobs = await fetchBomFeishuScanJobsForBatch(batchId, 20);
      return jobs.find((j) => j.id === jobId) ?? null;
    },
    isDone: (j) => feishuScanJobIsTerminal(j.status),
    isSuccess: (j) => j.status === 'succeeded',
  });
  if (job.status !== 'succeeded') {
    throw new Error(`飞书扫描失败：${job.message?.trim() || job.status}`);
  }
  return job;
}

async function waitFeishuUploadJob(
  batchId: string,
  jobId: string,
  batchName: string,
  signal?: AbortSignal,
  step?: PipelineNotifyStepOpts,
): Promise<BomFeishuUploadJob> {
  const job = await pollByteJobWithNotify({
    label: '飞书上传',
    batchName,
    signal,
    step,
    runningAlreadyInTotal: true,
    fetchOne: async () => {
      const jobs = await fetchBomFeishuUploadJobsForBatch(batchId, 20);
      return jobs.find((j) => j.id === jobId) ?? null;
    },
    isDone: (j) => feishuUploadJobIsTerminal(j.status),
  });
  if (job.status !== 'succeeded') {
    throw new Error(`飞书上传失败：${job.lastMessage?.trim() || job.status}`);
  }
  return job;
}

async function waitFeishuVersionSheetJob(
  batchId: string,
  jobId: string,
  batchName: string,
  signal?: AbortSignal,
  step?: PipelineNotifyStepOpts,
): Promise<BomFeishuVersionSheetJob> {
  const job = await pollSimpleJobWithNotify({
    label: '生成软件包清单',
    batchName,
    signal,
    step,
    fetchOne: async () => {
      const jobs = await fetchBomFeishuVersionSheetJobsForBatch(batchId, 20);
      return jobs.find((j) => j.id === jobId) ?? null;
    },
    isDone: (j) => !feishuVersionSheetJobIsActive(j.status),
    isSuccess: (j) => j.status === 'succeeded',
  });
  if (job.status !== 'succeeded') {
    throw new Error(`生成软件包清单失败：${job.message?.trim() || job.status}`);
  }
  return job;
}

async function waitAllRowsVerifiedOk(
  batchId: string,
  expectedCount: number,
  batchName: string,
  signal?: AbortSignal,
  scopeIds?: Set<string> | null,
  step?: PipelineNotifyStepOpts,
): Promise<BomBatchRow[]> {
  const selectScope = (rows: BomBatchRow[]) =>
    scopeIds ? rows.filter((row) => scopeIds.has(row.id)) : rows;
  const initialRows = await fetchBomRows(batchId);
  const initialScope = selectScope(initialRows);
  if (initialScope.length !== expectedCount) {
    throw new Error(`作用域行数异常：期望 ${expectedCount}，实际 ${initialScope.length}`);
  }
  if (initialScope.every((row) => row.status.local === 'verified_ok')) {
    await sendFeishuNotify(
      buildPipelineSkipNotifyText({
        title: '本地校验',
        batchName,
        detail: `作用域内 ${expectedCount} 行已全部校验通过`,
        ...step,
      }),
    );
    return initialScope;
  }

  const started = Date.now();
  for (;;) {
    throwIfAborted(signal);
    await refreshBomRowStatusesForBatch(batchId);
    const rows = await fetchBomRows(batchId);
    const scope = selectScope(rows);
    if (scope.length !== expectedCount) {
      throw new Error(`作用域行数异常：期望 ${expectedCount}，实际 ${scope.length}`);
    }
    if (scope.every((row) => row.status.local === 'verified_ok')) {
      await sendFeishuNotify(
        buildJobEndNotifyText({
          title: '本地校验',
          batchName,
          ok: true,
          elapsedSec: (Date.now() - started) / 1000,
          detail: `${scope.length} 行全部通过`,
          ...step,
        }),
      );
      return scope;
    }

    const failed = scope.filter(
      (row) => row.status.local === 'verified_fail' || row.status.local === 'error',
    );
    if (failed.length > 0 && Date.now() - started > 15_000) {
      const detail = failed
        .slice(0, 5)
        .map((row) => row.status.local_fetch_error || row.status.local)
        .join('；');
      throw new Error(`本地校验未通过（${failed.length}/${scope.length}）：${detail}`);
    }
    if (Date.now() - started > VERIFY_TIMEOUT_MS) {
      const pending = scope.filter((row) => row.status.local !== 'verified_ok').length;
      throw new Error(`等待本地校验超时：仍有 ${pending} 行未通过`);
    }
    await sleep(POLL_MS, signal);
  }
}

/**
 * 对已有版本执行同步流水线：本地（必选）→ 可选 ext → 可选飞书。
 */
export async function runBomSyncPipeline(input: SyncPipelineOptions): Promise<SyncPipelineResult> {
  const batchId = input.batchId.trim();
  const batchName = input.batchName.trim() || batchId;
  if (!batchId) throw new Error('缺少版本 ID');

  const doExt = Boolean(input.doExt);
  const doFeishu = Boolean(input.doFeishu);
  const enrichMd5 = input.enrichMd5 !== false;
  const signal = input.signal;
  const report = (p: SyncPipelineProgress) => input.onProgress?.(p);

  let loaded = await fetchBomRows(batchId);
  if (loaded.length === 0) throw new Error('当前版本没有数据行');

  const resolveScope = (
    all: BomBatchRow[],
    rowIds?: string[] | null,
  ): { scope: BomBatchRow[]; scopeIds: Set<string> | null; scoped: boolean } => {
    const requested = [...new Set((rowIds ?? []).map((id) => id.trim()).filter(Boolean))];
    if (requested.length === 0) return { scope: all, scopeIds: null, scoped: false };
    const wanted = new Set(requested);
    const scope = all.filter((row) => wanted.has(row.id));
    const found = new Set(scope.map((row) => row.id));
    const missing = requested.filter((id) => !found.has(id));
    if (missing.length > 0) {
      throw new Error(`选中行不存在或不属于当前版本：${missing.slice(0, 5).join(', ')}`);
    }
    return { scope, scopeIds: wanted, scoped: true };
  };
  const currentScope = () => resolveScope(loaded, input.rowIds);
  let { scope, scopeIds, scoped } = currentScope();
  if (scope.length === 0) throw new Error('当前作用域没有数据行');

  const phases: SyncPipelinePhase[] = [
    ...(enrichMd5 ? (['enrich_md5'] as SyncPipelinePhase[]) : []),
    'download',
    'wait_verified',
    ...(doExt ? (['ext_sync'] as SyncPipelinePhase[]) : []),
    ...(doFeishu
      ? (['feishu_scan', 'feishu_upload', 'version_sheet'] as SyncPipelinePhase[])
      : []),
    'done',
  ];
  const stepFor = (phase: SyncPipelinePhase): PipelineNotifyStepOpts => ({
    stepIndex: phases.indexOf(phase) + 1,
    stepTotal: phases.length,
  });
  const skip = async (phase: SyncPipelinePhase, title: string, detail: string) => {
    await sendFeishuNotify(
      buildPipelineSkipNotifyText({ title, batchName, detail, ...stepFor(phase) }),
    );
  };
  const scopedRpcIds = () => (scoped ? [...scopeIds!] : null);

  const config: BomScannerConfig = await fetchBomScannerSettings();
  const keyMap: BomJsonKeyMap = config.jsonKeyMap;

  if (enrichMd5) {
    const missingBefore = scope.filter(
      (row) => !extractExpectedMd5FromRow(row.bom_row, keyMap),
    );
    if (missingBefore.length === 0) {
      await skip('enrich_md5', '补全 MD5', `作用域内 ${scope.length} 行均已有 MD5`);
    } else {
      report({
        phase: 'enrich_md5',
        message: `从 Artifactory Storage API 补全 MD5（${missingBefore.length}/${scope.length} 行）…`,
        batchId,
        batchName,
        rowCount: scope.length,
      });
      throwIfAborted(signal);
      const af = await fetchArtifactorySettings();
      if (!af) throw new Error('无法读取 Artifactory 配置，请检查系统设置');
      const { rows: enriched, summary } = await enrichBomRowsFromArtifactory(
        missingBefore,
        keyMap,
        af,
      );
      for (const row of enriched) {
        const md5 = extractExpectedMd5FromRow(row.bom_row, keyMap);
        if (md5) {
          const next = { ...row.bom_row };
          for (const key of keyMap.expectedMd5?.length ? keyMap.expectedMd5 : ['MD5']) {
            if (key.trim()) next[key.trim()] = md5;
          }
          row.bom_row = next;
        }
        const original = missingBefore.find((item) => item.id === row.id);
        const bomChanged = JSON.stringify(original?.bom_row) !== JSON.stringify(row.bom_row);
        const itErrChanged =
          (original?.status.it_fetch_error ?? null) !== (row.status.it_fetch_error ?? null);
        if (bomChanged || itErrChanged) {
          await updateBomRowBomAndStatusFetchErrors(row.id, row.bom_row, {
            it_fetch_error: row.status.it_fetch_error ?? null,
          });
        }
      }
      const toEnsure = [keyMap.fileSizeBytes?.[0]].filter(Boolean) as string[];
      if (toEnsure.length > 0) {
        const batchMeta = await fetchBomBatchById(batchId);
        await updateBomBatchHeaderOrder(
          batchId,
          mergeHeaderOrder(batchMeta?.headerOrder ?? [], toEnsure),
        );
      }
      loaded = await fetchBomRows(batchId);
      ({ scope, scopeIds, scoped } = currentScope());
      const missingMd5 = scope.filter(
        (row) => !extractExpectedMd5FromRow(row.bom_row, keyMap),
      );
      if (missingMd5.length > 0) {
        const samples = missingMd5.slice(0, 5).map((row) => {
          const component = extractComponentFromRow(row.bom_row, keyMap) ?? row.id.slice(0, 8);
          const raw = extractDownloadUrlRaw(row.bom_row, keyMap);
          const url = raw ? extractHttpUrlFromDownloadCell(raw) : null;
          const reason = row.status.it_fetch_error?.trim()
            || (!raw ? '缺少下载地址' : !url ? '下载地址不是有效 HTTP(S) URL' : 'API 未返回 MD5');
          return `${component}：${reason}`;
        });
        const tip = summary.failedChunks > 0
          ? `；请求批次失败 ${summary.failedChunks} 次`
          : summary.apiRespondedErrorCount > 0
            ? `；Storage API 失败 ${summary.apiRespondedErrorCount} 行`
            : summary.apiOkButNoMd5Count > 0
              ? `；API 成功但无 MD5 ${summary.apiOkButNoMd5Count} 行`
              : '';
        throw new Error(
          `作用域内有 ${missingMd5.length} 行未能补全 MD5${tip}。示例：${samples.join('；')}`,
        );
      }
      await sendFeishuNotify(
        buildJobEndNotifyText({
          title: '补全 MD5',
          batchName,
          ok: true,
          detail: `已补全 ${summary.md5FilledCount} 行`,
          ...stepFor('enrich_md5'),
        }),
      );
    }
  }

  report({
    phase: 'download',
    message: '检查本地是否已有文件…',
    batchId,
    batchName,
    rowCount: scope.length,
  });
  throwIfAborted(signal);
  await refreshBomRowStatusesForBatch(batchId);
  loaded = await fetchBomRows(batchId);
  ({ scope, scopeIds, scoped } = currentScope());

  const md5List = scope
    .map((row) => extractExpectedMd5FromRow(row.bom_row, keyMap))
    .filter((md5): md5 is string => Boolean(md5));
  const localInfoByMd5 = await fetchLocalFileInfoByMd5(md5List);
  const pullIds = scope
    .filter((row) => rowEligibleForItPull(row, keyMap, localInfoByMd5))
    .map((row) => row.id);
  const verifiedCount = scope.filter((row) => row.status.local === 'verified_ok').length;

  let downloadJobId: string | null = null;
  if (pullIds.length === 0) {
    if (verifiedCount === scope.length) {
      report({
        phase: 'download',
        message: `本地已有全部 ${scope.length} 个文件，跳过拉取`,
        batchId,
        batchName,
        rowCount: scope.length,
      });
      await skip('download', '本地拉取', `作用域内 ${scope.length} 行均已有本地文件`);
    } else {
      const sample = scope
        .filter((row) => row.status.local !== 'verified_ok')
        .slice(0, 5)
        .map((row) => {
          const component = extractComponentFromRow(row.bom_row, keyMap) ?? row.id.slice(0, 8);
          const raw = extractDownloadUrlRaw(row.bom_row, keyMap);
          const url = raw ? extractHttpUrlFromDownloadCell(raw) : null;
          const md5 = extractExpectedMd5FromRow(row.bom_row, keyMap);
          return `${component}(${row.status.local}${!md5 ? '/无MD5' : !raw ? '/无下载地址' : !url ? '/地址无效' : ''})`;
        })
        .join('；');
      throw new Error(
        `没有可拉取的行，且尚未全部校验通过（${verifiedCount}/${scope.length}）。示例：${sample || '—'}`,
      );
    }
  } else {
    report({
      phase: 'download',
      message: `入队本地拉取（${pullIds.length}/${scope.length} 行）…`,
      batchId,
      batchName,
      rowCount: scope.length,
    });
    throwIfAborted(signal);
    try {
      downloadJobId = await requestBomItDownload(batchId, scopedRpcIds());
    } catch (error) {
      await refreshBomRowStatusesForBatch(batchId);
      loaded = await fetchBomRows(batchId);
      ({ scope, scopeIds, scoped } = currentScope());
      if (scope.every((row) => row.status.local === 'verified_ok')) {
        await skip('download', '本地拉取', '入队期间文件已全部就绪');
      } else {
        throw error;
      }
    }
    if (downloadJobId) {
      report({
        phase: 'download',
        message: '正在拉取到本地…',
        batchId,
        batchName,
        rowCount: scope.length,
        jobId: downloadJobId,
      });
      await waitDownloadJob(
        batchId,
        downloadJobId,
        batchName,
        signal,
        stepFor('download'),
      );
    }
  }

  report({
    phase: 'wait_verified',
    message: '等待本地 MD5 校验通过…',
    batchId,
    batchName,
    rowCount: scope.length,
  });
  scope = await waitAllRowsVerifiedOk(
    batchId,
    scope.length,
    batchName,
    signal,
    scopeIds,
    stepFor('wait_verified'),
  );
  loaded = await fetchBomRows(batchId);
  ({ scope, scopeIds, scoped } = currentScope());

  let extSyncJobId: string | null = null;
  if (doExt) {
    const eligible = scope.filter((row) => rowEligibleForExtSync(row, keyMap));
    if (eligible.length === 0) {
      if (scope.every((row) => rowExtUiComplete(row, keyMap))) {
        report({
          phase: 'ext_sync',
          message: `Artifactory-ext 已覆盖全部 ${scope.length} 行，跳过同步`,
          batchId,
          batchName,
          rowCount: scope.length,
        });
        await skip('ext_sync', 'Artifactory-ext 同步', `作用域内 ${scope.length} 行均已完成`);
      } else {
        const sample = scope
          .filter((row) => !rowExtUiComplete(row, keyMap))
          .slice(0, 5)
          .map((row) => {
            const component = extractComponentFromRow(row.bom_row, keyMap) ?? row.id.slice(0, 8);
            const ext = extractExtUrlFromRow(row.bom_row, keyMap);
            const md5 = extractExpectedMd5FromRow(row.bom_row, keyMap);
            return `${component}(local=${row.status.local}, ext=${row.status.ext}, md5=${md5 ? '有' : '无'}, ext_url=${ext ? '有' : '无'})`;
          })
          .join('；');
        throw new Error(`没有可同步到 Artifactory-ext 的行，且存在未完成行。示例：${sample || '—'}`);
      }
    } else {
      report({
        phase: 'ext_sync',
        message: `入队 Artifactory-ext 同步（${eligible.length}/${scope.length} 行）…`,
        batchId,
        batchName,
        rowCount: scope.length,
      });
      throwIfAborted(signal);
      try {
        extSyncJobId = await requestBomExtSync(batchId, scopedRpcIds());
      } catch (error) {
        loaded = await fetchBomRows(batchId);
        ({ scope, scopeIds, scoped } = currentScope());
        if (scope.every((row) => rowExtUiComplete(row, keyMap))) {
          await skip('ext_sync', 'Artifactory-ext 同步', '入队期间作用域内行已全部完成');
        } else {
          throw error;
        }
      }
      if (extSyncJobId) {
        report({
          phase: 'ext_sync',
          message: '正在同步到 Artifactory-ext…',
          batchId,
          batchName,
          rowCount: scope.length,
          jobId: extSyncJobId,
        });
        await waitExtSyncJob(
          batchId,
          extSyncJobId,
          batchName,
          signal,
          stepFor('ext_sync'),
        );
      }
    }
  }

  let feishuScanJobId: string | null = null;
  let feishuUploadJobId: string | null = null;
  let versionSheetJobId: string | null = null;
  let versionSheetUrl: string | null = null;

  if (doFeishu) {
    report({
      phase: 'feishu_scan',
      message: '入队飞书扫描（自动创建版本目录）…',
      batchId,
      batchName,
      rowCount: scope.length,
    });
    throwIfAborted(signal);
    const scanRes = await requestBomFeishuScan(batchId, { autoCreateVersionFolder: true });
    if (!scanRes.ok) throw new Error(scanRes.error || '飞书扫描入队失败');
    feishuScanJobId = scanRes.jobId;
    if (!feishuScanJobId) throw new Error('飞书扫描未返回任务 ID');
    await waitFeishuScanJob(
      batchId,
      feishuScanJobId,
      batchName,
      signal,
      stepFor('feishu_scan'),
    );

    loaded = await fetchBomRows(batchId);
    ({ scope, scopeIds, scoped } = currentScope());
    const uploadIds = scope
      .filter((row) => {
        if (row.status.local !== 'verified_ok') return false;
        if (row.status.feishu !== 'absent' && row.status.feishu !== 'error') return false;
        return !feishuScanErrorBlocksFeishuUpload(row.status.feishu_scan_error);
      })
      .map((row) => row.id);
    const presentCount = scope.filter((row) => row.status.feishu === 'present').length;

    if (uploadIds.length === 0) {
      if (presentCount === scope.length) {
        report({
          phase: 'feishu_upload',
          message: `飞书清单已覆盖全部 ${scope.length} 个包，跳过上传`,
          batchId,
          batchName,
          rowCount: scope.length,
        });
        await skip('feishu_upload', '飞书上传', `作用域内 ${scope.length} 行均已存在`);
      } else {
        const sample = scope
          .slice(0, 5)
          .map((row) => `${extractComponentFromRow(row.bom_row, keyMap) ?? row.id.slice(0, 8)}(${row.status.feishu ?? 'not_scanned'}${row.status.feishu_scan_error ? '/有扫描错误' : ''})`)
          .join('；');
        throw new Error(
          `飞书扫描后没有可上传的行（present ${presentCount}/${scope.length}）。示例：${sample}`,
        );
      }
    } else {
      report({
        phase: 'feishu_upload',
        message: `入队飞书上传（${uploadIds.length}/${scope.length} 行）…`,
        batchId,
        batchName,
        rowCount: scope.length,
      });
      throwIfAborted(signal);
      feishuUploadJobId = await requestBomFeishuUpload(
        batchId,
        scopedRpcIds(),
      );
      await waitFeishuUploadJob(
        batchId,
        feishuUploadJobId,
        batchName,
        signal,
        stepFor('feishu_upload'),
      );
    }

    report({
      phase: 'version_sheet',
      message: '生成版本目录「软件包清单」…',
      batchId,
      batchName,
      rowCount: scope.length,
    });
    throwIfAborted(signal);
    const sheetRes = await requestBomFeishuVersionSheet(batchId);
    if (!sheetRes.ok) throw new Error(sheetRes.error || '软件包清单入队失败');
    versionSheetJobId = sheetRes.jobId;
    const sheetJob = await waitFeishuVersionSheetJob(
      batchId,
      versionSheetJobId,
      batchName,
      signal,
      stepFor('version_sheet'),
    );
    versionSheetUrl = sheetJob.sheetUrl?.trim() || null;
  }

  report({
    phase: 'done',
    message: versionSheetUrl ? `同步完成；软件包清单：${versionSheetUrl}` : '同步流水线已完成',
    batchId,
    batchName,
    rowCount: scope.length,
  });
  await sendFeishuNotify(
    buildPipelineDoneNotifyText({
      batchName,
      rowCount: scope.length,
      doExt,
      doFeishu,
      versionSheetUrl,
      ...stepFor('done'),
    }),
  );

  return {
    batchId,
    batchName,
    rowCount: scope.length,
    downloadJobId,
    extSyncJobId,
    feishuScanJobId,
    feishuUploadJobId,
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
