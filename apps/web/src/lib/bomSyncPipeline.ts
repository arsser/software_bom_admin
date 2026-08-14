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
  extractExpectedMd5FromRow,
  rowEligibleForItPull,
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
  sendFeishuNotify,
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
            void sendFeishuNotify(
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
            void sendFeishuNotify(
              buildJobEndNotifyText({
                title: opts.label,
                batchName: opts.batchName,
                jobId: v.id,
                ok,
                elapsedSec: elapsed,
                bytesTotal: v.bytesTotal,
                avgSpeedBps: avgSpeed,
                detail: (v.lastMessage || v.message || '').trim() || undefined,
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
}): Promise<T> {
  let progressNotified = false;
  for (;;) {
    throwIfAborted(opts.signal);
    const v = await opts.fetchOne();
    if (v != null) {
      if (!progressNotified && v.status === 'running') {
        progressNotified = true;
        void sendFeishuNotify(
          buildJobProgressNotifyText({
            title: `${opts.label}进行中`,
            batchName: opts.batchName,
            jobId: v.id,
            extra: '（无字节进度，任务已开始）',
          }),
        );
      }
      if (opts.isDone(v)) {
        if (opts.isSuccess(v)) {
          void sendFeishuNotify(
            buildJobEndNotifyText({
              title: opts.label,
              batchName: opts.batchName,
              jobId: v.id,
              ok: true,
              elapsedSec: elapsedSecSince(v.startedAt, v.finishedAt),
              detail: (v.message || v.lastMessage || '').trim() || undefined,
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
): Promise<BomDownloadJob> {
  const job = await pollByteJobWithNotify({
    label: '本地拉取',
    batchName,
    signal,
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
): Promise<BomExtSyncJob> {
  const job = await pollByteJobWithNotify({
    label: 'Artifactory-ext 同步',
    batchName,
    signal,
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
): Promise<BomFeishuScanJob> {
  const job = await pollSimpleJobWithNotify({
    label: '飞书扫描',
    batchName,
    signal,
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
): Promise<BomFeishuUploadJob> {
  const job = await pollByteJobWithNotify({
    label: '飞书上传',
    batchName,
    signal,
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
): Promise<BomFeishuVersionSheetJob> {
  const job = await pollSimpleJobWithNotify({
    label: '生成软件包清单',
    batchName,
    signal,
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
  signal?: AbortSignal,
): Promise<BomBatchRow[]> {
  const started = Date.now();
  for (;;) {
    throwIfAborted(signal);
    await refreshBomRowStatusesForBatch(batchId);
    const rows = await fetchBomRows(batchId);
    if (rows.length !== expectedCount) {
      throw new Error(`行数异常：期望 ${expectedCount}，实际 ${rows.length}`);
    }
    const ok = rows.every((r) => r.status.local === 'verified_ok');
    if (ok) return rows;

    const failed = rows.filter(
      (r) => r.status.local === 'verified_fail' || r.status.local === 'error',
    );
    if (failed.length > 0 && Date.now() - started > 15_000) {
      const detail = failed
        .slice(0, 5)
        .map((r) => r.status.local_fetch_error || r.status.local)
        .join('；');
      throw new Error(`本地校验未通过（${failed.length}/${rows.length}）：${detail}`);
    }

    if (Date.now() - started > VERIFY_TIMEOUT_MS) {
      const pending = rows.filter((r) => r.status.local !== 'verified_ok').length;
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

  const config: BomScannerConfig = await fetchBomScannerSettings();
  const keyMap: BomJsonKeyMap = config.jsonKeyMap;

  if (enrichMd5) {
    const missingBefore = loaded.filter((r) => !extractExpectedMd5FromRow(r.bom_row, keyMap));
    if (missingBefore.length > 0) {
      report({
        phase: 'enrich_md5',
        message: '从 Artifactory Storage API 补全 MD5…',
        batchId,
        batchName,
        rowCount: loaded.length,
      });
      throwIfAborted(signal);
      const af = await fetchArtifactorySettings();
      if (!af) throw new Error('无法读取 Artifactory 配置，请检查系统设置');
      const { rows: enriched, summary } = await enrichBomRowsFromArtifactory(loaded, keyMap, af);
      for (const r of enriched) {
        const md5 = extractExpectedMd5FromRow(r.bom_row, keyMap);
        if (!md5) continue;
        const next = { ...r.bom_row };
        for (const k of keyMap.expectedMd5?.length ? keyMap.expectedMd5 : ['MD5']) {
          if (k.trim()) next[k.trim()] = md5;
        }
        r.bom_row = next;
      }
      const toEnsure = [keyMap.fileSizeBytes?.[0]].filter(Boolean) as string[];
      const batchMeta = await fetchBomBatchById(batchId);
      const ho = mergeHeaderOrder(batchMeta?.headerOrder ?? [], toEnsure);
      for (let i = 0; i < enriched.length; i += 1) {
        const a = loaded[i];
        const b = enriched[i];
        if (!a || !b) continue;
        const bomChanged = JSON.stringify(a.bom_row) !== JSON.stringify(b.bom_row);
        const itErrChanged = (a.status.it_fetch_error ?? null) !== (b.status.it_fetch_error ?? null);
        if (bomChanged || itErrChanged) {
          await updateBomRowBomAndStatusFetchErrors(b.id, b.bom_row, {
            it_fetch_error: b.status.it_fetch_error ?? null,
          });
        }
      }
      if (toEnsure.length) await updateBomBatchHeaderOrder(batchId, ho);
      loaded = await fetchBomRows(batchId);
      const missingMd5 = loaded.filter((r) => !extractExpectedMd5FromRow(r.bom_row, keyMap));
      if (missingMd5.length > 0) {
        const tip =
          summary.apiRespondedErrorCount > 0
            ? `（Storage API 失败 ${summary.apiRespondedErrorCount} 行）`
            : summary.apiOkButNoMd5Count > 0
              ? `（API 成功但无 MD5 ${summary.apiOkButNoMd5Count} 行）`
              : '';
        throw new Error(`有 ${missingMd5.length} 行未能补全 MD5，无法继续同步${tip}`);
      }
      report({
        phase: 'enrich_md5',
        message: `已补全 MD5 ${summary.md5FilledCount || loaded.length} 行`,
        batchId,
        batchName,
        rowCount: loaded.length,
      });
    }
  }

  report({
    phase: 'download',
    message: '检查本地是否已有文件…',
    batchId,
    batchName,
    rowCount: loaded.length,
  });
  throwIfAborted(signal);
  await refreshBomRowStatusesForBatch(batchId);
  loaded = await fetchBomRows(batchId);

  const md5List = loaded
    .map((r) => extractExpectedMd5FromRow(r.bom_row, keyMap))
    .filter((m): m is string => Boolean(m));
  const localInfoByMd5 = await fetchLocalFileInfoByMd5(md5List);
  const pullIds = loaded.filter((r) => rowEligibleForItPull(r, keyMap, localInfoByMd5)).map((r) => r.id);
  const verifiedCount = loaded.filter((r) => r.status.local === 'verified_ok').length;

  let downloadJobId: string | null = null;
  if (pullIds.length === 0) {
    if (verifiedCount === loaded.length) {
      report({
        phase: 'download',
        message: `本地已有全部 ${loaded.length} 个文件，跳过拉取`,
        batchId,
        batchName,
        rowCount: loaded.length,
      });
    } else {
      const sample = loaded
        .filter((r) => r.status.local !== 'verified_ok')
        .slice(0, 3)
        .map((r) => {
          const md5 = extractExpectedMd5FromRow(r.bom_row, keyMap) ?? '无MD5';
          return `${r.status.local}/${md5.slice(0, 8)}`;
        })
        .join(', ');
      throw new Error(
        `没有可拉取的行，且尚未全部校验通过（已通过 ${verifiedCount}/${loaded.length}）。状态示例：${sample || '—'}`,
      );
    }
  } else {
    report({
      phase: 'download',
      message: `入队本地拉取（${pullIds.length}/${loaded.length} 行）…`,
      batchId,
      batchName,
      rowCount: loaded.length,
    });
    throwIfAborted(signal);
    try {
      downloadJobId = await requestBomItDownload(batchId, pullIds);
    } catch (e) {
      await refreshBomRowStatusesForBatch(batchId);
      loaded = await fetchBomRows(batchId);
      if (loaded.every((r) => r.status.local === 'verified_ok')) {
        report({
          phase: 'download',
          message: `本地已有全部文件，跳过拉取`,
          batchId,
          batchName,
          rowCount: loaded.length,
        });
      } else {
        throw e;
      }
    }
    if (downloadJobId) {
      report({
        phase: 'download',
        message: '正在拉取到本地…',
        batchId,
        batchName,
        rowCount: loaded.length,
        jobId: downloadJobId,
      });
      await waitDownloadJob(batchId, downloadJobId, batchName, signal);
    }
  }

  report({
    phase: 'wait_verified',
    message: '等待本地 MD5 校验通过…',
    batchId,
    batchName,
    rowCount: loaded.length,
  });
  await waitAllRowsVerifiedOk(batchId, loaded.length, signal);
  loaded = await fetchBomRows(batchId);

  let extSyncJobId: string | null = null;
  if (doExt) {
    report({
      phase: 'ext_sync',
      message: '入队 Artifactory-ext 同步…',
      batchId,
      batchName,
      rowCount: loaded.length,
    });
    throwIfAborted(signal);
    extSyncJobId = await requestBomExtSync(batchId, null);
    report({
      phase: 'ext_sync',
      message: '正在同步到 Artifactory-ext…',
      batchId,
      batchName,
      rowCount: loaded.length,
      jobId: extSyncJobId,
    });
    await waitExtSyncJob(batchId, extSyncJobId, batchName, signal);
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
      rowCount: loaded.length,
    });
    throwIfAborted(signal);
    const scanRes = await requestBomFeishuScan(batchId, { autoCreateVersionFolder: true });
    if (!scanRes.ok) {
      throw new Error(scanRes.error || '飞书扫描入队失败');
    }
    feishuScanJobId = scanRes.jobId;
    if (!feishuScanJobId) throw new Error('飞书扫描未返回任务 ID');
    report({
      phase: 'feishu_scan',
      message: '正在扫描飞书目录…',
      batchId,
      batchName,
      rowCount: loaded.length,
      jobId: feishuScanJobId,
    });
    await waitFeishuScanJob(batchId, feishuScanJobId, batchName, signal);

    loaded = await fetchBomRows(batchId);
    const uploadIds = loaded
      .filter((r) => {
        if (r.status.local !== 'verified_ok') return false;
        const f = r.status.feishu;
        if (f !== 'absent' && f !== 'error') return false;
        if (feishuScanErrorBlocksFeishuUpload(r.status.feishu_scan_error)) return false;
        return true;
      })
      .map((r) => r.id);
    const presentCount = loaded.filter((r) => r.status.feishu === 'present').length;

    if (uploadIds.length === 0) {
      if (presentCount === loaded.length) {
        report({
          phase: 'feishu_upload',
          message: `飞书清单已覆盖全部 ${loaded.length} 个包（全局去重），跳过文件上传`,
          batchId,
          batchName,
          rowCount: loaded.length,
        });
      } else {
        const sample = loaded
          .slice(0, 5)
          .map((r) => `${r.status.feishu ?? 'not_scanned'}${r.status.feishu_scan_error ? '(有扫描错误)' : ''}`)
          .join(', ');
        throw new Error(
          `飞书扫描后没有可上传的行（present ${presentCount}/${loaded.length}）。状态：${sample}`,
        );
      }
    } else {
      report({
        phase: 'feishu_upload',
        message: `入队飞书上传（${uploadIds.length}/${loaded.length} 行；其余可全局去重）…`,
        batchId,
        batchName,
        rowCount: loaded.length,
      });
      throwIfAborted(signal);
      feishuUploadJobId = await requestBomFeishuUpload(batchId, uploadIds);
      report({
        phase: 'feishu_upload',
        message: '正在上传到飞书…',
        batchId,
        batchName,
        rowCount: loaded.length,
        jobId: feishuUploadJobId,
      });
      await waitFeishuUploadJob(batchId, feishuUploadJobId, batchName, signal);
    }

    report({
      phase: 'version_sheet',
      message: '生成版本目录「软件包清单」…',
      batchId,
      batchName,
      rowCount: loaded.length,
    });
    throwIfAborted(signal);
    const sheetRes = await requestBomFeishuVersionSheet(batchId);
    if (!sheetRes.ok) {
      throw new Error(sheetRes.error || '软件包清单入队失败');
    }
    versionSheetJobId = sheetRes.jobId;
    report({
      phase: 'version_sheet',
      message: sheetRes.reused ? '等待已有软件包清单任务…' : '正在生成软件包清单…',
      batchId,
      batchName,
      rowCount: loaded.length,
      jobId: versionSheetJobId,
    });
    const sheetJob = await waitFeishuVersionSheetJob(batchId, versionSheetJobId, batchName, signal);
    versionSheetUrl = sheetJob.sheetUrl?.trim() || null;
  }

  report({
    phase: 'done',
    message: versionSheetUrl
      ? `同步完成；软件包清单：${versionSheetUrl}`
      : '同步流水线已完成',
    batchId,
    batchName,
    rowCount: loaded.length,
  });

  void sendFeishuNotify(
    buildPipelineDoneNotifyText({
      batchName,
      rowCount: loaded.length,
      doExt,
      doFeishu,
      versionSheetUrl,
    }),
  );

  return {
    batchId,
    batchName,
    rowCount: loaded.length,
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
