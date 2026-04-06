import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Activity, ChevronDown, ChevronUp } from 'lucide-react';
import { fetchBomScannerSettings, type BomScannerConfig } from '../lib/bomScannerSettings';
import { useBomWorkerHeartbeat } from '../lib/useBomWorkerHeartbeat';

type Props = {
  collapsed: boolean;
};

/**
 * 侧边栏：bom-scanner-worker 全局心跳（绿=正常空闲，橙=正常忙碌，红=离线/超时），悬停 title + 点击展开详情。
 */
export function SidebarWorkerHeartbeat({ collapsed }: Props) {
  const navigate = useNavigate();
  const [config, setConfig] = useState<BomScannerConfig | null>(null);
  const [fetchFailed, setFetchFailed] = useState(false);
  const [settingsReady, setSettingsReady] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const c = await fetchBomScannerSettings();
        if (!cancelled) {
          setConfig(c);
          setFetchFailed(false);
          setSettingsReady(true);
        }
      } catch {
        if (!cancelled) {
          setFetchFailed(true);
          setConfig(null);
          setSettingsReady(true);
        }
      }
    };
    void load();
    const id = window.setInterval(() => void load(), 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  const hb = useBomWorkerHeartbeat(config);

  const level = fetchFailed ? 'offline' : hb?.level ?? 'offline';
  const idleOk = settingsReady && level === 'ok_idle';
  const busyOk = settingsReady && level === 'ok_busy';
  const loading = !settingsReady;

  const summary =
    fetchFailed && !config
      ? '无法读取 BOM 扫描配置，无法判断 worker 心跳。请检查网络与权限。'
      : hb?.summary ?? (loading ? '正在读取…' : '无心跳数据');

  const titleShort = loading
    ? '正在读取 worker 状态…'
    : idleOk
      ? `Worker 在线（空闲）· ${hb?.lastBeatAt ? new Date(hb.lastBeatAt).toLocaleString() : ''}`
      : busyOk
        ? `Worker 在线（忙碌）· ${hb?.lastBeatAt ? new Date(hb.lastBeatAt).toLocaleString() : ''}`
        : fetchFailed
          ? 'Worker 状态未知（配置拉取失败）'
          : 'Worker 离线或心跳超时';

  const iconClass = loading
    ? 'text-slate-400'
    : idleOk
      ? 'text-emerald-600'
      : busyOk
        ? 'text-orange-600'
        : 'text-red-600';

  const ringBg = loading
    ? 'bg-slate-100'
    : idleOk
      ? 'bg-emerald-50'
      : busyOk
        ? 'bg-orange-50'
        : 'bg-red-50';

  const labelText = loading ? '…' : idleOk ? '空闲' : busyOk ? '忙碌' : '离线';

  const labelColor = loading
    ? 'text-slate-500'
    : idleOk
      ? 'text-emerald-800'
      : busyOk
        ? 'text-orange-900'
        : 'text-red-800';

  return (
    <div className="px-0 pt-0 pb-1 -mx-1">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        title={titleShort}
        className={`w-full flex items-center gap-2 rounded-lg px-2 py-2 text-left transition-colors hover:bg-slate-50 ${
          collapsed ? 'justify-center' : 'justify-between'
        }`}
        aria-expanded={expanded}
        aria-label={`Worker 心跳：${loading ? '加载中' : idleOk ? '空闲' : busyOk ? '忙碌' : '离线'}。${expanded ? '收起' : '展开'}详情`}
      >
        <span className={`flex items-center gap-2 min-w-0 ${collapsed ? 'justify-center' : ''}`}>
          <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${ringBg}`}>
            <Activity size={18} className={iconClass} strokeWidth={2.25} aria-hidden />
          </span>
          {!collapsed && (
            <span className={`text-xs font-medium truncate ${labelColor}`}>Worker {labelText}</span>
          )}
        </span>
        {!collapsed &&
          (expanded ? (
            <ChevronUp size={16} className="text-slate-400 shrink-0" aria-hidden />
          ) : (
            <ChevronDown size={16} className="text-slate-400 shrink-0" aria-hidden />
          ))}
      </button>

      {expanded && !collapsed && (
        <div className="mt-1 mb-1 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-2 text-[11px] text-slate-700 leading-snug space-y-2">
          <p>{summary}</p>
          <p className="text-slate-500">
            全局心跳：
            <code className="px-1 rounded bg-white border border-slate-200 font-mono text-[10px]">
              runtime.workerReportedAt
            </code>
            ；忙碌标记：
            <code className="px-1 rounded bg-white border border-slate-200 font-mono text-[10px]">
              runtime.workerPhase
            </code>
          </p>
          <button
            type="button"
            onClick={() => navigate('/settings')}
            className="text-indigo-600 hover:text-indigo-800 font-medium"
          >
            打开系统设置 → BOM 本地扫描
          </button>
        </div>
      )}

      {expanded && collapsed && (
        <div className="mt-1 rounded-lg border border-slate-200 bg-slate-50 px-1.5 py-1.5 text-[10px] text-slate-700 leading-snug text-center space-y-1">
          <p className="line-clamp-5">{summary}</p>
          <button
            type="button"
            onClick={() => navigate('/settings')}
            className="text-indigo-600 font-medium"
          >
            设置
          </button>
        </div>
      )}
    </div>
  );
}
