import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { LucideIcon } from 'lucide-react';
import { Package, Database, HardDrive, Share2, Loader2, AlertCircle } from 'lucide-react';
import { fetchBomDashboardStats, type BomDashboardStats } from '../lib/bomDashboardStats';
import { formatBytesHuman } from '../lib/bytesFormat';

const StatCard = ({
  icon: Icon,
  label,
  value,
  subtext,
  color,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  subtext?: string;
  color: string;
}) => (
  <div className="bg-white p-6 rounded-xl border border-gray-200 shadow-sm flex items-start justify-between">
    <div className="min-w-0 flex-1">
      <p className="text-sm font-medium text-slate-500 mb-1">{label}</p>
      <h3 className="text-2xl font-bold text-slate-800 truncate" title={value}>
        {value}
      </h3>
      {subtext ? <p className="mt-2 text-xs text-slate-400">{subtext}</p> : null}
    </div>
    <div className={`p-3 rounded-lg ${color} text-white shrink-0 ml-3`}>
      <Icon size={20} />
    </div>
  </div>
);

export const Dashboard: React.FC = () => {
  const [stats, setStats] = useState<BomDashboardStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const s = await fetchBomDashboardStats();
      setStats(s);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setStats(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const extPct =
    stats && stats.bomRowCount > 0
      ? Math.round((stats.rowsExtSynced / stats.bomRowCount) * 100)
      : stats && stats.bomRowCount === 0
        ? 0
        : null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold text-slate-900">仪表盘</h2>
          <p className="text-slate-500">软件 BOM 与本地暂存概览</p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="inline-flex items-center gap-2 px-3 py-1.5 text-sm rounded-lg border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 disabled:opacity-50"
        >
          {loading ? <Loader2 size={14} className="animate-spin" /> : null}
          刷新数据
        </button>
      </div>

      {err ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 flex items-start gap-2">
          <AlertCircle size={18} className="shrink-0 mt-0.5" />
          <div>
            <p className="font-medium">无法加载统计</p>
            <p className="text-amber-800/90 mt-1">{err}</p>
            <p className="text-xs text-amber-800/80 mt-2">
              若刚部署，请确认已执行迁移 <code className="font-mono">20260409110000_bom_dashboard_stats</code>。
            </p>
          </div>
        </div>
      ) : null}

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-6">
        <StatCard
          icon={Package}
          label="BOM 版本（批次）"
          value={loading && !stats ? '…' : String(stats?.bomBatchCount ?? 0)}
          subtext="已创建的 BOM 批次数量"
          color="bg-indigo-600"
        />
        <StatCard
          icon={Database}
          label="BOM 行（软件包条目）"
          value={loading && !stats ? '…' : String(stats?.bomRowCount ?? 0)}
          subtext="所有批次中行总数"
          color="bg-slate-700"
        />
        <StatCard
          icon={Share2}
          label="ext 转存已完成"
          value={loading && !stats ? '…' : String(stats?.rowsExtSynced ?? 0)}
          subtext={extPct != null ? `约占全部行的 ${extPct}%` : undefined}
          color="bg-emerald-600"
        />
        <StatCard
          icon={HardDrive}
          label="本地暂存文件"
          value={loading && !stats ? '…' : String(stats?.localFileCount ?? 0)}
          subtext={
            stats != null
              ? `不同 MD5 数 ${stats.localDistinctMd5} · 合计 ${formatBytesHuman(stats.localTotalBytes)}`
              : undefined
          }
          color="bg-blue-600"
        />
      </div>

      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6">
        <h3 className="text-sm font-semibold text-slate-800 mb-3">快捷入口</h3>
        <div className="flex flex-wrap gap-3 text-sm">
          <Link
            to="/bom"
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-indigo-200 bg-indigo-50 text-indigo-900 hover:bg-indigo-100"
          >
            <Package size={16} />
            BOM 管理
          </Link>
          <Link
            to="/bom/jobs"
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-slate-200 bg-slate-50 text-slate-800 hover:bg-slate-100"
          >
            下载与同步任务
          </Link>
          <Link
            to="/settings"
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-slate-200 bg-slate-50 text-slate-800 hover:bg-slate-100"
          >
            系统设置
          </Link>
        </div>
      </div>
    </div>
  );
};
