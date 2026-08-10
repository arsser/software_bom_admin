import { formatBytesHuman } from './bytesFormat';

/** 三类任务共有的字节进度字段 */
export type BomJobByteProgress = {
  status: string;
  bytesDownloadedTotal: number;
  bytesTotal: number | null;
  runningBytesDownloaded: number;
  runningBytesTotal: number | null;
  /** 已完成行/文件数（不含当前正在处理的） */
  progressCurrent?: number;
  progressTotal?: number;
  /** 任务开始时间 ms，用于整批平均速度 */
  startedAtMs?: number | null;
};

/**
 * 已传输字节。
 * - IT 拉取 / ext 同步：进度中只更新 running_*，累计在完成后写入 → 需相加
 * - 飞书上传：进度中 bytes_downloaded_total 已含当前文件 → 直接用累计
 */
export function jobEffectiveTransferredBytes(
  job: BomJobByteProgress,
  runningAlreadyInTotal: boolean,
): number {
  const done = Math.max(0, job.bytesDownloadedTotal);
  if (job.status === 'running' && !runningAlreadyInTotal) {
    return done + Math.max(0, job.runningBytesDownloaded);
  }
  return done;
}

export function formatSpeedLabel(bytesPerSec: number): string {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return '—';
  return `${formatBytesHuman(bytesPerSec)}/s`;
}

export type JobTransferLiveStats = {
  speedBps: number | null;
  /** 整批任务预计剩余秒数（不含「当前文件」回退） */
  etaSec: number | null;
};

type SpeedSample = { t: number; bytes: number; speedBps: number | null };

/**
 * 轮询采样瞬时速度；时间列 ETA 只按整批估算：
 * 1) 有 bytesTotal → 剩余字节 / 速度（优先任务开始以来的平均速度）
 * 2) 否则有 progress → 剩余行数 / 行速
 * 不再回退到「当前文件」ETA。
 */
export function computeJobTransferLiveStats(
  job: BomJobByteProgress,
  runningAlreadyInTotal: boolean,
  sample: SpeedSample | undefined,
  nowMs: number,
): { stats: JobTransferLiveStats; nextSample: SpeedSample } {
  const transferred = jobEffectiveTransferredBytes(job, runningAlreadyInTotal);
  let instantSpeedBps: number | null = sample?.speedBps ?? null;

  if (job.status === 'running') {
    if (sample && nowMs > sample.t) {
      const dtSec = (nowMs - sample.t) / 1000;
      const dBytes = transferred - sample.bytes;
      if (dtSec >= 0.5 && dBytes >= 0) {
        const instant = dBytes / dtSec;
        instantSpeedBps =
          sample.speedBps != null && sample.speedBps > 0
            ? sample.speedBps * 0.4 + instant * 0.6
            : instant;
      } else if (dBytes < 0) {
        instantSpeedBps = null;
      }
    }
  } else {
    instantSpeedBps = null;
  }

  let etaSec: number | null = null;
  if (job.status === 'running') {
    const startedAtMs = job.startedAtMs ?? null;
    const elapsedSec =
      startedAtMs != null && nowMs > startedAtMs ? (nowMs - startedAtMs) / 1000 : null;

    // 整批速度：优先任务开始以来的平均吞吐，其次轮询瞬时速度
    let jobSpeedBps: number | null = null;
    if (elapsedSec != null && elapsedSec >= 1.5 && transferred > 0) {
      jobSpeedBps = transferred / elapsedSec;
    } else if (instantSpeedBps != null && instantSpeedBps > 0) {
      jobSpeedBps = instantSpeedBps;
    }

    if (job.bytesTotal != null && jobSpeedBps != null && jobSpeedBps > 0) {
      if (job.bytesTotal > transferred) {
        etaSec = (job.bytesTotal - transferred) / jobSpeedBps;
      } else {
        etaSec = 0;
      }
    } else {
      // 无总字节时：按已完成行数估整批剩余（含当前未完成行）
      const doneRows = Math.max(0, Number(job.progressCurrent ?? 0));
      const totalRows = Math.max(0, Number(job.progressTotal ?? 0));
      if (totalRows > 0 && elapsedSec != null && elapsedSec >= 1.5 && doneRows > 0) {
        const rowSpeed = doneRows / elapsedSec;
        if (rowSpeed > 0) {
          const remainingRows = Math.max(0, totalRows - doneRows);
          etaSec = remainingRows / rowSpeed;
        }
      }
    }
  }

  return {
    stats: {
      speedBps: job.status === 'running' ? instantSpeedBps : null,
      etaSec,
    },
    nextSample: { t: nowMs, bytes: transferred, speedBps: instantSpeedBps },
  };
}
