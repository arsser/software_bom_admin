import { WifiOff } from 'lucide-react';
import type { BomWorkerHeartbeatInfo } from '../lib/bomWorkerHeartbeat';

type Props = {
  info: BomWorkerHeartbeatInfo | null;
  /** 设置尚未拉取完成时不渲染 */
  settingsLoading?: boolean;
  className?: string;
};

/**
 * 仅在 worker 离线或全局心跳超时时展示横幅；正常空闲/忙碌时不占位。
 */
export function BomWorkerHeartbeatAlert({ info, settingsLoading, className }: Props) {
  if (settingsLoading || !info || info.level === 'ok_idle' || info.level === 'ok_busy') return null;

  return (
    <div
      className={`rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm flex gap-3 items-start text-red-950 ${className ?? ''}`}
      role="status"
    >
      <WifiOff className="shrink-0 mt-0.5" size={20} aria-hidden />
      <div className="min-w-0 space-y-1">
        <div className="font-semibold">bom-scanner-worker 离线或心跳超时</div>
        <p className="text-xs leading-snug opacity-95">{info.summary}</p>
        <p className="text-[11px] leading-snug opacity-90">
          全局心跳由 worker 写入{' '}
          <code className="px-1 rounded bg-black/5 font-mono text-[10px]">runtime.workerReportedAt</code>
          ；拉取/同步/扫描期间会定期刷新，超时则视为掉线。
        </p>
      </div>
    </div>
  );
}
