/**
 * worker 将 BOM_LOCAL_ROOT、心跳时间、忙碌状态写入 system_settings.bom_scanner.runtime（见 bom-scanner-worker reportBomLocalRootRuntime）。
 */

/** 绿=正常空闲；橙=正常忙碌；红=离线或无有效心跳/超时 */
export type BomWorkerHeartbeatLevel = 'ok_idle' | 'ok_busy' | 'offline';

export type BomWorkerHeartbeatInfo = {
  level: BomWorkerHeartbeatLevel;
  lastBeatAt: Date | null;
  /** 距上次心跳的毫秒数；offline 且无有效时间时为 null */
  ageMs: number | null;
  summary: string;
  /** worker 回报的运行阶段提示（如 it-download、ext-sync、scan） */
  busyHint?: string;
};

function isWorkerBusyPhase(phase: string | undefined | null): boolean {
  const p = (phase ?? '').trim().toLowerCase();
  return p === 'busy';
}

/**
 * @param workerReportedAt ISO 时间字符串，来自 DB
 * @param scanIntervalSeconds 用于估算「多久算掉线」（取 max(90s, 3×扫描间隔)）
 * @param workerPhase runtime.workerPhase：busy 表示正在拉取/同步/扫描等长任务
 */
export function getBomWorkerHeartbeatInfo(
  workerReportedAt: string | undefined | null,
  scanIntervalSeconds: number,
  nowMs: number = Date.now(),
  workerPhase?: string | null,
  workerBusyHint?: string | null,
): BomWorkerHeartbeatInfo {
  const hint =
    typeof workerBusyHint === 'string' && workerBusyHint.trim() ? workerBusyHint.trim() : undefined;
  const t = (workerReportedAt ?? '').trim();
  if (!t) {
    return {
      level: 'offline',
      lastBeatAt: null,
      ageMs: null,
      summary:
        '未收到 worker 心跳。请启动 bom-scanner-worker（否则拉取、扫描、本地索引与状态收敛不会执行）。',
    };
  }
  const last = new Date(t);
  const ts = last.getTime();
  if (!Number.isFinite(ts)) {
    return {
      level: 'offline',
      lastBeatAt: null,
      ageMs: null,
      summary: 'worker 上报时间格式无效，无法判断在线状态。',
    };
  }

  const ageMs = Math.max(0, nowMs - ts);
  const intervalSec = Number.isFinite(scanIntervalSeconds) && scanIntervalSeconds > 0 ? scanIntervalSeconds : 30;
  const intervalMs = Math.max(5000, intervalSec * 1000);
  const staleThresholdMs = Math.max(90_000, intervalMs * 3);

  if (ageMs > staleThresholdMs) {
    const mins = Math.floor(ageMs / 60_000);
    const ago =
      mins >= 1
        ? `约 ${mins} 分钟前`
        : `约 ${Math.max(1, Math.round(ageMs / 1000))} 秒前`;
    return {
      level: 'offline',
      lastBeatAt: last,
      ageMs,
      summary: `已超时：上次全局心跳为 ${last.toLocaleString()}（${ago}）。worker 可能已停止或未连上数据库。`,
    };
  }

  const sec = Math.max(0, Math.round(ageMs / 1000));
  const baseTime = `上次全局心跳：${last.toLocaleString()}（${sec === 0 ? '刚刚' : `${sec} 秒前`}）`;

  if (isWorkerBusyPhase(workerPhase)) {
    const detail = hint ? `当前任务：${hint}。` : '';
    return {
      level: 'ok_busy',
      lastBeatAt: last,
      ageMs,
      busyHint: hint,
      summary: `${baseTime} ${detail}Worker 在线且正在执行耗时任务。`,
    };
  }

  return {
    level: 'ok_idle',
    lastBeatAt: last,
    ageMs,
    summary: `${baseTime} Worker 在线且空闲。`,
  };
}
