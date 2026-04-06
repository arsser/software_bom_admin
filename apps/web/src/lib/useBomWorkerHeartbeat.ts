import { useEffect, useMemo, useState } from 'react';
import type { BomScannerConfig } from './bomScannerSettings';
import { getBomWorkerHeartbeatInfo, type BomWorkerHeartbeatInfo } from './bomWorkerHeartbeat';

/**
 * 定时刷新心跳判定，避免页面常驻时「在线」一直不变成「掉线」。
 */
export function useBomWorkerHeartbeat(
  config: BomScannerConfig | null,
  pollMs: number = 15000,
): BomWorkerHeartbeatInfo | null {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), pollMs);
    return () => window.clearInterval(id);
  }, [pollMs]);

  return useMemo(() => {
    if (!config) return null;
    return getBomWorkerHeartbeatInfo(
      config.workerReportedAt,
      config.scanIntervalSeconds,
      now,
      config.workerPhase,
      config.workerBusyHint,
    );
  }, [config, now]);
}
