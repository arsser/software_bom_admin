import { formatBytesHuman } from './bytesFormat';

/** 三类任务共有的字节进度字段 */
export type BomJobByteProgress = {
  status: string;
  bytesDownloadedTotal: number;
  bytesTotal: number | null;
  runningBytesDownloaded: number;
  runningBytesTotal: number | null;
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
  etaSec: number | null;
};

type SpeedSample = { t: number; bytes: number; speedBps: number | null };

/** 根据轮询采样估算瞬时速度，并用剩余字节算 ETA */
export function computeJobTransferLiveStats(
  job: BomJobByteProgress,
  runningAlreadyInTotal: boolean,
  sample: SpeedSample | undefined,
  nowMs: number,
): { stats: JobTransferLiveStats; nextSample: SpeedSample } {
  const transferred = jobEffectiveTransferredBytes(job, runningAlreadyInTotal);
  let speedBps: number | null = sample?.speedBps ?? null;

  if (job.status === 'running') {
    if (sample && nowMs > sample.t) {
      const dtSec = (nowMs - sample.t) / 1000;
      const dBytes = transferred - sample.bytes;
      if (dtSec >= 0.5 && dBytes >= 0) {
        const instant = dBytes / dtSec;
        // 轻微平滑，避免 2s 轮询抖动过大
        speedBps =
          sample.speedBps != null && sample.speedBps > 0
            ? sample.speedBps * 0.4 + instant * 0.6
            : instant;
      } else if (dBytes < 0) {
        // 文件切换等导致回退，重置速度
        speedBps = null;
      }
    }
  } else {
    speedBps = null;
  }

  let etaSec: number | null = null;
  if (job.status === 'running' && speedBps != null && speedBps > 0) {
    if (job.bytesTotal != null && job.bytesTotal > transferred) {
      etaSec = (job.bytesTotal - transferred) / speedBps;
    } else if (
      job.runningBytesTotal != null &&
      job.runningBytesTotal > job.runningBytesDownloaded
    ) {
      etaSec = (job.runningBytesTotal - job.runningBytesDownloaded) / speedBps;
    } else if (job.bytesTotal != null && job.bytesTotal <= transferred) {
      etaSec = 0;
    }
  }

  return {
    stats: {
      speedBps: job.status === 'running' ? speedBps : null,
      etaSec,
    },
    nextSample: { t: nowMs, bytes: transferred, speedBps },
  };
}
