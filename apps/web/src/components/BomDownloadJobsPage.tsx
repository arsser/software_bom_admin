import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, HardDriveDownload, Loader2, RefreshCcw, Upload, XCircle } from 'lucide-react';
import {
  BOM_DOWNLOAD_JOB_STATUS_LABEL,
  cancelBomDownloadJob,
  downloadJobProgressPercent,
  fetchBomDownloadJobsForUser,
  formatDownloadJobBytesLine,
  type BomDownloadJob,
  type BomDownloadJobStatus,
} from '../lib/bomDownloadJobs';
import {
  BOM_EXT_SYNC_JOB_STATUS_LABEL,
  cancelBomExtSyncJob,
  extSyncJobProgressPercent,
  fetchBomExtSyncJobsForUser,
  type BomExtSyncJob,
  type BomExtSyncJobStatus,
} from '../lib/bomExtSyncJobs';
import { fetchBomBatches, type BomBatch } from '../lib/bomBatches';

type StatusFilter = 'all' | BomDownloadJobStatus | BomExtSyncJobStatus;

export const BomDownloadJobsPage: React.FC = () => {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [jobs, setJobs] = useState<BomDownloadJob[]>([]);
  const [extJobs, setExtJobs] = useState<BomExtSyncJob[]>([]);
  const [batches, setBatches] = useState<BomBatch[]>([]);
  const [cancelBusy, setCancelBusy] = useState<string | null>(null);
  const [extCancelBusy, setExtCancelBusy] = useState<string | null>(null);

  const batchIdFilter = searchParams.get('batchId') ?? '';
  const statusFilter = (searchParams.get('status') as StatusFilter) || 'all';

  const setBatchFilter = (id: string) => {
    const next = new URLSearchParams(searchParams);
    if (id.trim()) next.set('batchId', id.trim());
    else next.delete('batchId');
    setSearchParams(next, { replace: true });
  };

  const setStatusParam = (s: StatusFilter) => {
    const next = new URLSearchParams(searchParams);
    if (s === 'all') next.delete('status');
    else next.set('status', s);
    setSearchParams(next, { replace: true });
  };

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [bs, js, ej] = await Promise.all([
        fetchBomBatches(),
        fetchBomDownloadJobsForUser({
          batchId: batchIdFilter || null,
          status: statusFilter,
          limit: 100,
        }),
        fetchBomExtSyncJobsForUser({
          batchId: batchIdFilter || null,
          status: statusFilter,
          limit: 100,
        }),
      ]);
      setBatches(bs);
      const idToLabel = new Map(bs.map((b) => [b.id, `${b.productName} · ${b.name}`]));
      setJobs(js.map((j) => ({ ...j, batchName: j.batchName ?? idToLabel.get(j.batchId) ?? null })));
      setExtJobs(ej.map((j) => ({ ...j, batchName: j.batchName ?? idToLabel.get(j.batchId) ?? null })));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batchIdFilter, statusFilter]);

  const hasActive = useMemo(
    () =>
      jobs.some((j) => j.status === 'queued' || j.status === 'running') ||
      extJobs.some((j) => j.status === 'queued' || j.status === 'running'),
    [jobs, extJobs],
  );

  const batchLabelById = useMemo(
    () => new Map(batches.map((b) => [b.id, `${b.productName} · ${b.name}`])),
    [batches],
  );

  useEffect(() => {
    if (!hasActive) return;
    const id = window.setInterval(() => {
      void Promise.all([
        fetchBomDownloadJobsForUser({
          batchId: batchIdFilter || null,
          status: statusFilter,
          limit: 100,
        }),
        fetchBomExtSyncJobsForUser({
          batchId: batchIdFilter || null,
          status: statusFilter,
          limit: 100,
        }),
      ]).then(([js, ej]) => {
        setJobs(js.map((j) => ({ ...j, batchName: j.batchName ?? batchLabelById.get(j.batchId) ?? null })));
        setExtJobs(ej.map((j) => ({ ...j, batchName: j.batchName ?? batchLabelById.get(j.batchId) ?? null })));
      });
    }, 2000);
    return () => window.clearInterval(id);
  }, [hasActive, batchIdFilter, statusFilter, batchLabelById]);

  const handleCancel = async (jobId: string) => {
    setCancelBusy(jobId);
    try {
      const ok = await cancelBomDownloadJob(jobId);
      if (!ok) alert('无法取消：任务已结束、无权操作，或请刷新后重试。');
      await load();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setCancelBusy(null);
    }
  };

  const handleCancelExt = async (jobId: string) => {
    setExtCancelBusy(jobId);
    try {
      const ok = await cancelBomExtSyncJob(jobId);
      if (!ok) alert('无法取消：任务已结束、无权操作，或请刷新后重试。');
      await load();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setExtCancelBusy(null);
    }
  };

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-lg bg-indigo-600 text-white flex items-center justify-center flex-shrink-0">
            <HardDriveDownload size={22} />
          </div>
          <div>
            <button
              type="button"
              onClick={() => navigate('/bom')}
              className="inline-flex items-center gap-1.5 text-slate-600 hover:text-slate-800 text-sm"
            >
              <ArrowLeft size={16} />
              返回 BOM 管理
            </button>
            <h2 className="text-2xl font-bold text-slate-900 mt-1">BOM 后台任务</h2>
            <p className="text-slate-500 mt-1 text-sm">
              it-Artifactory 拉取与 ext-Artifactory 同步队列（均由 bom-scanner-worker 执行）。
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50"
        >
          <RefreshCcw size={16} />
          刷新
        </button>
      </div>

      {error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      ) : null}

      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4 flex flex-wrap gap-3 items-end">
        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1">版本</label>
          <select
            value={batchIdFilter}
            onChange={(e) => setBatchFilter(e.target.value)}
            className="px-3 py-2 border border-gray-200 rounded-lg bg-white text-sm min-w-[12rem]"
          >
            <option value="">全部版本</option>
            {batches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.productName} · {b.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1">状态</label>
          <select
            value={statusFilter}
            onChange={(e) => setStatusParam(e.target.value as StatusFilter)}
            className="px-3 py-2 border border-gray-200 rounded-lg bg-white text-sm"
          >
            <option value="all">全部</option>
            <option value="queued">排队中</option>
            <option value="running">拉取中</option>
            <option value="succeeded">已完成</option>
            <option value="failed">失败</option>
            <option value="cancelled">已取消</option>
          </select>
        </div>
        <p className="text-xs text-slate-500 pb-2">
          {loading ? '加载中…' : `it 拉取 ${jobs.length} 条 · ext 同步 ${extJobs.length} 条`}
          {hasActive ? ' · 自动刷新中' : ''}
        </p>
      </div>

      <div className="flex items-center gap-2 text-sm font-medium text-slate-800">
        <HardDriveDownload size={18} className="text-indigo-600" />
        it-Artifactory 拉取
      </div>

      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr>
                <th className="px-3 py-2 text-left text-xs font-semibold text-slate-700">状态</th>
                <th className="px-3 py-2 text-left text-xs font-semibold text-slate-700">版本</th>
                <th className="px-3 py-2 text-left text-xs font-semibold text-slate-700">进度</th>
                <th className="px-3 py-2 text-left text-xs font-semibold text-slate-700">字节</th>
                <th className="px-3 py-2 text-left text-xs font-semibold text-slate-700">说明</th>
                <th className="px-3 py-2 text-left text-xs font-semibold text-slate-700">时间</th>
                <th className="px-3 py-2 text-right text-xs font-semibold text-slate-700">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {jobs.length === 0 && !loading ? (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-slate-500">
                    暂无任务。请在 BOM 明细页发起「拉取」。
                  </td>
                </tr>
              ) : null}
              {jobs.map((j) => {
                const pct = downloadJobProgressPercent(j);
                const bytesLine = formatDownloadJobBytesLine(j);
                const canCancelIt =
                  j.status === 'queued' || j.status === 'running';
                return (
                  <tr key={j.id} className="hover:bg-slate-50/80">
                    <td className="px-3 py-2 whitespace-nowrap">
                      <span className="inline-flex rounded-md border border-slate-200 bg-white px-2 py-0.5 text-xs font-medium text-slate-800">
                        {BOM_DOWNLOAD_JOB_STATUS_LABEL[j.status]}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <div className="font-medium text-slate-900">{j.batchName ?? '—'}</div>
                      <div className="text-[11px] text-slate-400 font-mono truncate max-w-[14rem]" title={j.batchId}>
                        {j.batchId}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-slate-700">
                      <div className="whitespace-nowrap">
                        {j.progressTotal > 0 ? `${j.progressCurrent}/${j.progressTotal} 文件` : '—'}
                      </div>
                      {(j.status === 'running' || j.status === 'queued') && pct > 0 ? (
                        <div className="mt-1 h-1.5 w-28 rounded-full bg-slate-100 overflow-hidden">
                          <div
                            className="h-full bg-indigo-600 transition-all duration-300"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-600 max-w-[14rem]">
                      {bytesLine ?? '—'}
                      {j.runningFileName && j.status === 'running' ? (
                        <div className="text-[11px] text-slate-400 truncate mt-0.5" title={j.runningFileName}>
                          {j.runningFileName}
                        </div>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-600 max-w-[20rem]">
                      <div className="line-clamp-2 font-mono break-all" title={j.lastMessage ?? ''}>
                        {j.lastMessage ?? '—'}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-500 whitespace-nowrap">
                      <div>创建 {new Date(j.createdAt).toLocaleString()}</div>
                      {j.finishedAt ? <div>结束 {new Date(j.finishedAt).toLocaleString()}</div> : null}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {canCancelIt ? (
                        <button
                          type="button"
                          disabled={cancelBusy === j.id}
                          onClick={() => void handleCancel(j.id)}
                          title={
                            j.status === 'running'
                              ? '请求取消正在执行的拉取（再次点击可强制取消）'
                              : '取消排队中的拉取任务'
                          }
                          className="inline-flex items-center gap-1 px-2 py-1 rounded border border-slate-300 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                        >
                          {cancelBusy === j.id ? <Loader2 size={12} className="animate-spin" /> : <XCircle size={12} />}
                          {j.status === 'running' ? '取消任务' : '取消排队'}
                        </button>
                      ) : (
                        <span className="text-slate-300">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {jobs.some((j) => j.status === 'running' || j.status === 'queued') ? (
          <div className="px-4 py-2 border-t border-slate-100 bg-slate-50 text-xs text-slate-500">
            进行中任务会每 2 秒刷新；字节进度依赖响应 Content-Length，无长度时仅显示已下载字节。
          </div>
        ) : null}
      </div>

      <div className="flex items-center gap-2 text-sm font-medium text-slate-800 pt-2">
        <Upload size={18} className="text-emerald-600" />
        ext-Artifactory 同步（阶段 5）
      </div>

      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr>
                <th className="px-3 py-2 text-left text-xs font-semibold text-slate-700">状态</th>
                <th className="px-3 py-2 text-left text-xs font-semibold text-slate-700">版本</th>
                <th className="px-3 py-2 text-left text-xs font-semibold text-slate-700">进度</th>
                <th className="px-3 py-2 text-left text-xs font-semibold text-slate-700">说明</th>
                <th className="px-3 py-2 text-left text-xs font-semibold text-slate-700">时间</th>
                <th className="px-3 py-2 text-right text-xs font-semibold text-slate-700">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {extJobs.length === 0 && !loading ? (
                <tr>
                  <td colSpan={6} className="px-4 py-10 text-center text-slate-500">
                    暂无任务。请在 BOM 明细页发起「同步全部」或单行 ext 同步。
                  </td>
                </tr>
              ) : null}
              {extJobs.map((j) => {
                const pct = extSyncJobProgressPercent(j);
                const canCancelExt =
                  j.status === 'queued' || j.status === 'running';
                return (
                  <tr key={j.id} className="hover:bg-slate-50/80">
                    <td className="px-3 py-2 whitespace-nowrap">
                      <span className="inline-flex rounded-md border border-emerald-200 bg-emerald-50/80 px-2 py-0.5 text-xs font-medium text-emerald-900">
                        {BOM_EXT_SYNC_JOB_STATUS_LABEL[j.status]}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <div className="font-medium text-slate-900">{j.batchName ?? '—'}</div>
                      <div className="text-[11px] text-slate-400 font-mono truncate max-w-[14rem]" title={j.batchId}>
                        {j.batchId}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-slate-700">
                      <div className="whitespace-nowrap">
                        {j.progressTotal > 0 ? `${j.progressCurrent}/${j.progressTotal} 行` : '—'}
                      </div>
                      {(j.status === 'running' || j.status === 'queued') && pct > 0 ? (
                        <div className="mt-1 h-1.5 w-28 rounded-full bg-slate-100 overflow-hidden">
                          <div
                            className="h-full bg-emerald-600 transition-all duration-300"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-600 max-w-[20rem]">
                      <div className="line-clamp-2 font-mono break-all" title={j.lastMessage ?? ''}>
                        {j.lastMessage ?? '—'}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-500 whitespace-nowrap">
                      <div>创建 {new Date(j.createdAt).toLocaleString()}</div>
                      {j.finishedAt ? <div>结束 {new Date(j.finishedAt).toLocaleString()}</div> : null}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {canCancelExt ? (
                        <button
                          type="button"
                          disabled={extCancelBusy === j.id}
                          onClick={() => void handleCancelExt(j.id)}
                          title={
                            j.status === 'running'
                              ? '请求取消正在执行的 ext 同步（再次点击可强制取消）'
                              : '取消排队中的 ext 同步任务'
                          }
                          className="inline-flex items-center gap-1 px-2 py-1 rounded border border-slate-300 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                        >
                          {extCancelBusy === j.id ? <Loader2 size={12} className="animate-spin" /> : <XCircle size={12} />}
                          {j.status === 'running' ? '取消任务' : '取消排队'}
                        </button>
                      ) : (
                        <span className="text-slate-300">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {extJobs.some((j) => j.status === 'running' || j.status === 'queued') ? (
          <div className="px-4 py-2 border-t border-slate-100 bg-emerald-50/50 text-xs text-slate-600">
            ext 同步任务进行中时每 2 秒刷新。
          </div>
        ) : null}
      </div>
    </div>
  );
};

