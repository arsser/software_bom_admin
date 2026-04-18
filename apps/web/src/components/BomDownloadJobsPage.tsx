import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  HardDriveDownload,
  ListTree,
  Loader2,
  RefreshCcw,
  Upload,
  UploadCloud,
  XCircle,
} from 'lucide-react';
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
import {
  BOM_FEISHU_UPLOAD_JOB_STATUS_LABEL,
  cancelBomFeishuUploadJob,
  feishuUploadJobProgressPercent,
  fetchBomFeishuUploadJobsForUser,
  type BomFeishuUploadJob,
  type BomFeishuUploadJobStatus,
} from '../lib/bomFeishuUploadJobs';
import { fetchBomBatches, type BomBatch } from '../lib/bomBatches';
import {
  fetchBomJobRowDetails,
  type BomJobDetailKind,
  type BomJobRowDetailLine,
} from '../lib/bomJobRowSnapshots';

const PAGE_STEP = 20;

type StatusFilter = 'all' | BomDownloadJobStatus | BomExtSyncJobStatus | BomFeishuUploadJobStatus;

function formatElapsedLabel(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h${m}m${sec}s`;
  if (m > 0) return `${m}m${sec}s`;
  return `${sec}s`;
}

function parseMsOrNull(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const n = Date.parse(iso);
  return Number.isFinite(n) ? n : null;
}

export const BomDownloadJobsPage: React.FC = () => {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [jobs, setJobs] = useState<BomDownloadJob[]>([]);
  const [extJobs, setExtJobs] = useState<BomExtSyncJob[]>([]);
  const [feishuJobs, setFeishuJobs] = useState<BomFeishuUploadJob[]>([]);
  const [batches, setBatches] = useState<BomBatch[]>([]);
  const [cancelBusy, setCancelBusy] = useState<string | null>(null);
  const [extCancelBusy, setExtCancelBusy] = useState<string | null>(null);
  const [feishuCancelBusy, setFeishuCancelBusy] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [expandedMessageKeys, setExpandedMessageKeys] = useState<Record<string, boolean>>({});
  const [copiedMessageKey, setCopiedMessageKey] = useState<string | null>(null);

  const [sectionItOpen, setSectionItOpen] = useState(true);
  const [sectionExtOpen, setSectionExtOpen] = useState(false);
  const [sectionFeishuOpen, setSectionFeishuOpen] = useState(false);

  const [itLimit, setItLimit] = useState(PAGE_STEP);
  const [extLimit, setExtLimit] = useState(PAGE_STEP);
  const [feishuLimit, setFeishuLimit] = useState(PAGE_STEP);
  const [itHasMore, setItHasMore] = useState(false);
  const [extHasMore, setExtHasMore] = useState(false);
  const [feishuHasMore, setFeishuHasMore] = useState(false);
  const skipLoadingOnceRef = useRef(false);

  const [detailOpen, setDetailOpen] = useState(false);
  const [detailTitle, setDetailTitle] = useState('');
  const [detailSubtitle, setDetailSubtitle] = useState('');
  const [detailLines, setDetailLines] = useState<BomJobRowDetailLine[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [listRefreshNonce, setListRefreshNonce] = useState(0);

  const batchIdFilter = searchParams.get('batchId') ?? '';
  const statusFilter = (searchParams.get('status') as StatusFilter) || 'all';

  const setBatchFilter = (id: string) => {
    setItLimit(PAGE_STEP);
    setExtLimit(PAGE_STEP);
    setFeishuLimit(PAGE_STEP);
    const next = new URLSearchParams(searchParams);
    if (id.trim()) next.set('batchId', id.trim());
    else next.delete('batchId');
    setSearchParams(next, { replace: true });
  };

  const setStatusParam = (s: StatusFilter) => {
    setItLimit(PAGE_STEP);
    setExtLimit(PAGE_STEP);
    setFeishuLimit(PAGE_STEP);
    const next = new URLSearchParams(searchParams);
    if (s === 'all') next.delete('status');
    else next.set('status', s);
    setSearchParams(next, { replace: true });
  };

  const fetchLists = async (quiet: boolean) => {
    const itL = itLimit;
    const extL = extLimit;
    const feiL = feishuLimit;
    if (!quiet) {
      setLoading(true);
      setError(null);
    }
    try {
      const [bs, js, ej, fj] = await Promise.all([
        fetchBomBatches(),
        fetchBomDownloadJobsForUser({
          batchId: batchIdFilter || null,
          status: statusFilter,
          limit: itL,
        }),
        fetchBomExtSyncJobsForUser({
          batchId: batchIdFilter || null,
          status: statusFilter,
          limit: extL,
        }),
        fetchBomFeishuUploadJobsForUser({
          batchId: batchIdFilter || null,
          status: statusFilter,
          limit: feiL,
        }),
      ]);
      setBatches(bs);
      const idToLabel = new Map(bs.map((b) => [b.id, `${b.productName} · ${b.name}`]));
      setJobs(js.map((j) => ({ ...j, batchName: j.batchName ?? idToLabel.get(j.batchId) ?? null })));
      setExtJobs(ej.map((j) => ({ ...j, batchName: j.batchName ?? idToLabel.get(j.batchId) ?? null })));
      setFeishuJobs(fj.map((j) => ({ ...j, batchName: j.batchName ?? idToLabel.get(j.batchId) ?? null })));
      setItHasMore(js.length === itL);
      setExtHasMore(ej.length === extL);
      setFeishuHasMore(fj.length === feiL);
    } catch (e) {
      if (!quiet) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (!quiet) setLoading(false);
    }
  };

  useEffect(() => {
    const quiet = skipLoadingOnceRef.current;
    skipLoadingOnceRef.current = false;
    void fetchLists(quiet);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batchIdFilter, statusFilter, itLimit, extLimit, feishuLimit, listRefreshNonce]);

  const hasActive = useMemo(
    () =>
      jobs.some((j) => j.status === 'queued' || j.status === 'running') ||
      extJobs.some((j) => j.status === 'queued' || j.status === 'running') ||
      feishuJobs.some((j) => j.status === 'queued' || j.status === 'running'),
    [jobs, extJobs, feishuJobs],
  );
  const hasRunningJob = useMemo(
    () =>
      jobs.some((j) => j.status === 'running') ||
      extJobs.some((j) => j.status === 'running') ||
      feishuJobs.some((j) => j.status === 'running'),
    [jobs, extJobs, feishuJobs],
  );

  const batchLabelById = useMemo(
    () => new Map(batches.map((b) => [b.id, `${b.productName} · ${b.name}`])),
    [batches],
  );

  useEffect(() => {
    if (!hasActive) return;
    const id = window.setInterval(() => {
      void fetchLists(true);
    }, 2000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasActive, batchIdFilter, statusFilter, batchLabelById, itLimit, extLimit, feishuLimit]);

  useEffect(() => {
    if (!hasRunningJob) return;
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [hasRunningJob]);

  const handleCancel = async (jobId: string) => {
    setCancelBusy(jobId);
    try {
      const ok = await cancelBomDownloadJob(jobId);
      if (!ok) alert('无法取消：任务已结束、无权操作，或请刷新后重试。');
      await fetchLists(false);
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
      await fetchLists(false);
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setExtCancelBusy(null);
    }
  };

  const handleCancelFeishu = async (jobId: string) => {
    setFeishuCancelBusy(jobId);
    try {
      const ok = await cancelBomFeishuUploadJob(jobId);
      if (!ok) alert('无法取消：任务已结束、无权操作，或请刷新后重试。');
      await fetchLists(false);
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setFeishuCancelBusy(null);
    }
  };

  const handleRefreshClick = () => {
    setItLimit(PAGE_STEP);
    setExtLimit(PAGE_STEP);
    setFeishuLimit(PAGE_STEP);
    setListRefreshNonce((n) => n + 1);
  };

  const handleLoadMoreIt = () => {
    skipLoadingOnceRef.current = true;
    setItLimit((n) => n + PAGE_STEP);
  };
  const handleLoadMoreExt = () => {
    skipLoadingOnceRef.current = true;
    setExtLimit((n) => n + PAGE_STEP);
  };
  const handleLoadMoreFeishu = () => {
    skipLoadingOnceRef.current = true;
    setFeishuLimit((n) => n + PAGE_STEP);
  };

  const openJobDetail = async (
    kind: BomJobDetailKind,
    jobLabel: string,
    batchId: string,
    batchName: string | null | undefined,
    jobId: string,
    rowIds: string[],
  ) => {
    setDetailOpen(true);
    setDetailTitle(`${jobLabel} · 行级详情`);
    setDetailSubtitle(`${batchName ?? batchId} · 任务 ${jobId} · 共 ${rowIds.length} 行（按任务入队顺序）`);
    setDetailLoading(true);
    setDetailError(null);
    setDetailLines([]);
    try {
      const lines = await fetchBomJobRowDetails(batchId, rowIds, kind);
      setDetailLines(lines);
    } catch (e) {
      setDetailError(e instanceof Error ? e.message : String(e));
    } finally {
      setDetailLoading(false);
    }
  };

  const closeJobDetail = () => {
    setDetailOpen(false);
    setDetailLines([]);
    setDetailError(null);
  };

  const toggleMessageExpanded = (key: string) => {
    setExpandedMessageKeys((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const copyToClipboard = async (text: string): Promise<boolean> => {
    if (!text.trim()) return false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      // fallback to execCommand below
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  };

  const handleCopyMessage = async (key: string, message: string | null) => {
    if (!message) return;
    const ok = await copyToClipboard(message);
    if (!ok) {
      alert('复制失败，请手动选择文本复制。');
      return;
    }
    setCopiedMessageKey(key);
    window.setTimeout(() => {
      setCopiedMessageKey((prev) => (prev === key ? null : prev));
    }, 1500);
  };

  const renderMessageCell = (key: string, message: string | null) => {
    const content = message ?? '—';
    const expanded = Boolean(expandedMessageKeys[key]);
    return (
      <div>
        <div
          className={expanded ? 'font-mono break-all whitespace-pre-wrap select-text' : 'line-clamp-2 font-mono break-all select-text'}
          title={!expanded ? content : undefined}
        >
          {content}
        </div>
        {message ? (
          <div className="mt-1 flex items-center gap-3 text-[11px]">
            <button
              type="button"
              onClick={() => toggleMessageExpanded(key)}
              className="text-indigo-600 hover:text-indigo-700 underline decoration-indigo-300/80"
            >
              {expanded ? '收起' : '展开'}
            </button>
            <button
              type="button"
              onClick={() => void handleCopyMessage(key, message)}
              className="text-slate-600 hover:text-slate-800 underline decoration-slate-300/80"
            >
              {copiedMessageKey === key ? '已复制' : '复制'}
            </button>
          </div>
        ) : null}
      </div>
    );
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
              内部 Artifactory 拉取、外部 Artifactory 同步、飞书云盘上传队列（均由 bom-scanner-worker 执行）。
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void handleRefreshClick()}
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
          {loading
            ? '加载中…'
            : `每类已加载 it ${jobs.length}（上限 ${itLimit}）· ext ${extJobs.length}（${extLimit}）· 飞书 ${feishuJobs.length}（${feishuLimit}）；点折叠区底部「加载更多」可提高上限`}
          {hasActive ? ' · 自动刷新中' : ''}
        </p>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <button
          type="button"
          onClick={() => setSectionItOpen((v) => !v)}
          className="flex w-full items-center gap-2 px-4 py-3 text-left hover:bg-slate-50/80 border-b border-slate-100"
        >
          {sectionItOpen ? <ChevronDown size={18} className="text-slate-500 shrink-0" /> : <ChevronRight size={18} className="text-slate-500 shrink-0" />}
          <HardDriveDownload size={18} className="text-indigo-600 shrink-0" />
          <span className="text-sm font-medium text-slate-800">内部 Artifactory 拉取</span>
          <span className="text-xs text-slate-500 ml-auto shrink-0">
            {jobs.length} 条
            {itHasMore ? ' · 可加载更多' : ''}
          </span>
        </button>
        {sectionItOpen ? (
        <>
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
                <th className="px-3 py-2 text-right text-xs font-semibold text-slate-700">详情</th>
                <th className="px-3 py-2 text-right text-xs font-semibold text-slate-700">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {jobs.length === 0 && !loading ? (
                <tr>
                  <td colSpan={8} className="px-4 py-10 text-center text-slate-500">
                    暂无任务。请在 BOM 明细页发起「拉取」。
                  </td>
                </tr>
              ) : null}
              {jobs.map((j) => {
                const pct = downloadJobProgressPercent(j);
                const bytesLine = formatDownloadJobBytesLine(j);
                const canCancelIt =
                  j.status === 'queued' || j.status === 'running';
                const startedMs = parseMsOrNull(j.startedAt);
                const finishedMs = parseMsOrNull(j.finishedAt);
                const endMs = j.status === 'running' ? nowMs : finishedMs;
                const elapsedSec =
                  startedMs != null && endMs != null && endMs >= startedMs
                    ? Math.round((endMs - startedMs) / 1000)
                    : null;
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
                      {renderMessageCell(`it-${j.id}`, j.lastMessage)}
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-500 whitespace-nowrap">
                      <div>创建 {new Date(j.createdAt).toLocaleString()}</div>
                      {j.startedAt ? <div>开始 {new Date(j.startedAt).toLocaleString()}</div> : null}
                      {j.finishedAt ? <div>结束 {new Date(j.finishedAt).toLocaleString()}</div> : null}
                      <div>
                        已用时{' '}
                        {elapsedSec != null
                          ? formatElapsedLabel(elapsedSec)
                          : j.status === 'queued'
                            ? '排队中'
                            : '—'}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      {j.rowIds.length > 0 ? (
                        <button
                          type="button"
                          onClick={() =>
                            void openJobDetail('it_download', '内部拉取', j.batchId, j.batchName, j.id, j.rowIds)
                          }
                          className="inline-flex items-center gap-1 px-2 py-1 rounded border border-indigo-200 text-xs text-indigo-800 hover:bg-indigo-50"
                          title="按任务 row_ids 查看每行文件名、本地索引大小与当前状态"
                        >
                          <ListTree size={12} />
                          详情
                        </button>
                      ) : (
                        <span className="text-slate-300">—</span>
                      )}
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
        {itHasMore ? (
          <div className="px-4 py-2 border-t border-slate-100 bg-white flex justify-center">
            <button
              type="button"
              onClick={() => handleLoadMoreIt()}
              className="text-xs font-medium text-indigo-700 hover:text-indigo-900 underline"
            >
              加载更多（每次 +{PAGE_STEP} 条，当前上限 {itLimit}）
            </button>
          </div>
        ) : null}
        {jobs.some((j) => j.status === 'running' || j.status === 'queued') ? (
          <div className="px-4 py-2 border-t border-slate-100 bg-slate-50 text-xs text-slate-500">
            进行中任务会每 2 秒刷新；字节进度依赖响应 Content-Length，无长度时仅显示已下载字节。
          </div>
        ) : null}
        </>
        ) : null}
      </div>

      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <button
          type="button"
          onClick={() => setSectionExtOpen((v) => !v)}
          className="flex w-full items-center gap-2 px-4 py-3 text-left hover:bg-slate-50/80 border-b border-slate-100"
        >
          {sectionExtOpen ? <ChevronDown size={18} className="text-slate-500 shrink-0" /> : <ChevronRight size={18} className="text-slate-500 shrink-0" />}
          <Upload size={18} className="text-emerald-600 shrink-0" />
          <span className="text-sm font-medium text-slate-800">外部 Artifactory 同步</span>
          <span className="text-xs text-slate-500 ml-auto shrink-0">
            {extJobs.length} 条
            {extHasMore ? ' · 可加载更多' : ''}
          </span>
        </button>
        {sectionExtOpen ? (
        <>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr>
                <th className="px-3 py-2 text-left text-xs font-semibold text-slate-700">状态</th>
                <th className="px-3 py-2 text-left text-xs font-semibold text-slate-700">版本</th>
                <th className="px-3 py-2 text-left text-xs font-semibold text-slate-700">进度</th>
                <th className="px-3 py-2 text-left text-xs font-semibold text-slate-700">说明</th>
                <th className="px-3 py-2 text-left text-xs font-semibold text-slate-700">时间</th>
                <th className="px-3 py-2 text-right text-xs font-semibold text-slate-700">详情</th>
                <th className="px-3 py-2 text-right text-xs font-semibold text-slate-700">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {extJobs.length === 0 && !loading ? (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-slate-500">
                    暂无任务。请在 BOM 明细页发起「同步全部」或单行 ext 同步。
                  </td>
                </tr>
              ) : null}
              {extJobs.map((j) => {
                const pct = extSyncJobProgressPercent(j);
                const canCancelExt =
                  j.status === 'queued' || j.status === 'running';
                const startedMs = parseMsOrNull(j.startedAt);
                const finishedMs = parseMsOrNull(j.finishedAt);
                const endMs = j.status === 'running' ? nowMs : finishedMs;
                const elapsedSec =
                  startedMs != null && endMs != null && endMs >= startedMs
                    ? Math.round((endMs - startedMs) / 1000)
                    : null;
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
                      {renderMessageCell(`ext-${j.id}`, j.lastMessage)}
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-500 whitespace-nowrap">
                      <div>创建 {new Date(j.createdAt).toLocaleString()}</div>
                      {j.startedAt ? <div>开始 {new Date(j.startedAt).toLocaleString()}</div> : null}
                      {j.finishedAt ? <div>结束 {new Date(j.finishedAt).toLocaleString()}</div> : null}
                      <div>
                        已用时{' '}
                        {elapsedSec != null
                          ? formatElapsedLabel(elapsedSec)
                          : j.status === 'queued'
                            ? '排队中'
                            : '—'}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      {j.rowIds.length > 0 ? (
                        <button
                          type="button"
                          onClick={() =>
                            void openJobDetail('ext_sync', 'ext 同步', j.batchId, j.batchName, j.id, j.rowIds)
                          }
                          className="inline-flex items-center gap-1 px-2 py-1 rounded border border-emerald-200 text-xs text-emerald-900 hover:bg-emerald-50"
                          title="按任务 row_ids 查看每行文件名、本地索引大小与 ext 状态"
                        >
                          <ListTree size={12} />
                          详情
                        </button>
                      ) : (
                        <span className="text-slate-300">—</span>
                      )}
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
        {extHasMore ? (
          <div className="px-4 py-2 border-t border-slate-100 bg-white flex justify-center">
            <button
              type="button"
              onClick={() => handleLoadMoreExt()}
              className="text-xs font-medium text-emerald-800 hover:text-emerald-950 underline"
            >
              加载更多（每次 +{PAGE_STEP} 条，当前上限 {extLimit}）
            </button>
          </div>
        ) : null}
        {extJobs.some((j) => j.status === 'running' || j.status === 'queued') ? (
          <div className="px-4 py-2 border-t border-slate-100 bg-emerald-50/50 text-xs text-slate-600">
            ext 同步任务进行中时每 2 秒刷新。
          </div>
        ) : null}
        </>
        ) : null}
      </div>

      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <button
          type="button"
          onClick={() => setSectionFeishuOpen((v) => !v)}
          className="flex w-full items-center gap-2 px-4 py-3 text-left hover:bg-slate-50/80 border-b border-slate-100"
        >
          {sectionFeishuOpen ? <ChevronDown size={18} className="text-slate-500 shrink-0" /> : <ChevronRight size={18} className="text-slate-500 shrink-0" />}
          <UploadCloud size={18} className="text-violet-600 shrink-0" />
          <span className="text-sm font-medium text-slate-800">飞书云盘上传</span>
          <span className="text-xs text-slate-500 ml-auto shrink-0">
            {feishuJobs.length} 条
            {feishuHasMore ? ' · 可加载更多' : ''}
          </span>
        </button>
        {sectionFeishuOpen ? (
        <>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr>
                <th className="px-3 py-2 text-left text-xs font-semibold text-slate-700">状态</th>
                <th className="px-3 py-2 text-left text-xs font-semibold text-slate-700">版本</th>
                <th className="px-3 py-2 text-left text-xs font-semibold text-slate-700">进度</th>
                <th className="px-3 py-2 text-left text-xs font-semibold text-slate-700">说明</th>
                <th className="px-3 py-2 text-left text-xs font-semibold text-slate-700">时间</th>
                <th className="px-3 py-2 text-right text-xs font-semibold text-slate-700">详情</th>
                <th className="px-3 py-2 text-right text-xs font-semibold text-slate-700">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {feishuJobs.length === 0 && !loading ? (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-slate-500">
                    暂无任务。请在 BOM 分发页发起「上传选中到飞书」。
                  </td>
                </tr>
              ) : null}
              {feishuJobs.map((j) => {
                const pct = feishuUploadJobProgressPercent(j);
                const canCancelFeishu =
                  j.status === 'queued' || j.status === 'running';
                const startedMs = parseMsOrNull(j.startedAt);
                const finishedMs = parseMsOrNull(j.finishedAt);
                const endMs = j.status === 'running' ? nowMs : finishedMs;
                const elapsedSec =
                  startedMs != null && endMs != null && endMs >= startedMs
                    ? Math.round((endMs - startedMs) / 1000)
                    : null;
                return (
                  <tr key={j.id} className="hover:bg-slate-50/80">
                    <td className="px-3 py-2 whitespace-nowrap">
                      <span className="inline-flex rounded-md border border-violet-200 bg-violet-50/80 px-2 py-0.5 text-xs font-medium text-violet-900">
                        {BOM_FEISHU_UPLOAD_JOB_STATUS_LABEL[j.status]}
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
                            className="h-full bg-violet-600 transition-all duration-300"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-600 max-w-[20rem]">
                      {renderMessageCell(`feishu-${j.id}`, j.lastMessage)}
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-500 whitespace-nowrap">
                      <div>创建 {new Date(j.createdAt).toLocaleString()}</div>
                      {j.startedAt ? <div>开始 {new Date(j.startedAt).toLocaleString()}</div> : null}
                      {j.finishedAt ? <div>结束 {new Date(j.finishedAt).toLocaleString()}</div> : null}
                      <div>
                        已用时{' '}
                        {elapsedSec != null
                          ? formatElapsedLabel(elapsedSec)
                          : j.status === 'queued'
                            ? '排队中'
                            : '—'}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      {j.rowIds.length > 0 ? (
                        <button
                          type="button"
                          onClick={() =>
                            void openJobDetail('feishu_upload', '飞书上传', j.batchId, j.batchName, j.id, j.rowIds)
                          }
                          className="inline-flex items-center gap-1 px-2 py-1 rounded border border-violet-200 text-xs text-violet-900 hover:bg-violet-50"
                          title="按任务 row_ids 查看每行文件名、本地索引大小与飞书状态"
                        >
                          <ListTree size={12} />
                          详情
                        </button>
                      ) : (
                        <span className="text-slate-300">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {canCancelFeishu ? (
                        <button
                          type="button"
                          disabled={feishuCancelBusy === j.id}
                          onClick={() => void handleCancelFeishu(j.id)}
                          title={
                            j.status === 'running'
                              ? '请求取消正在执行的飞书上传（再次点击可强制取消）'
                              : '取消排队中的飞书上传任务'
                          }
                          className="inline-flex items-center gap-1 px-2 py-1 rounded border border-slate-300 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                        >
                          {feishuCancelBusy === j.id ? <Loader2 size={12} className="animate-spin" /> : <XCircle size={12} />}
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
        {feishuHasMore ? (
          <div className="px-4 py-2 border-t border-slate-100 bg-white flex justify-center">
            <button
              type="button"
              onClick={() => handleLoadMoreFeishu()}
              className="text-xs font-medium text-violet-800 hover:text-violet-950 underline"
            >
              加载更多（每次 +{PAGE_STEP} 条，当前上限 {feishuLimit}）
            </button>
          </div>
        ) : null}
        {feishuJobs.some((j) => j.status === 'running' || j.status === 'queued') ? (
          <div className="px-4 py-2 border-t border-slate-100 bg-violet-50/50 text-xs text-slate-600">
            飞书上传任务进行中时每 2 秒刷新；分片进度（&gt;5MB 文件）实时显示在说明列。
          </div>
        ) : null}
        </>
        ) : null}
      </div>

      {detailOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-5xl max-h-[88vh] overflow-hidden rounded-xl border border-slate-300 bg-white shadow-2xl flex flex-col">
            <div className="flex items-center justify-between border-b border-slate-200 px-4 py-2 shrink-0">
              <div className="min-w-0 pr-2">
                <div className="text-sm font-medium text-slate-900 truncate" title={detailTitle}>
                  {detailTitle}
                </div>
                <div className="text-[11px] text-slate-500 truncate mt-0.5" title={detailSubtitle}>
                  {detailSubtitle}
                </div>
              </div>
              <button
                type="button"
                onClick={() => closeJobDetail()}
                className="rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-700 hover:bg-slate-50 shrink-0"
              >
                关闭
              </button>
            </div>
            <div className="p-3 overflow-auto flex-1 min-h-0">
              {detailLoading ? (
                <div className="flex items-center gap-2 text-sm text-slate-600 py-8 justify-center">
                  <Loader2 size={18} className="animate-spin" />
                  加载行明细…
                </div>
              ) : detailError ? (
                <div className="text-sm text-red-700 py-4">{detailError}</div>
              ) : (
                <div className="overflow-x-auto rounded-lg border border-slate-200">
                  <table className="min-w-full text-xs">
                    <thead className="bg-slate-50 border-b border-slate-200">
                      <tr>
                        <th className="px-2 py-2 text-left font-semibold text-slate-700">#</th>
                        <th className="px-2 py-2 text-left font-semibold text-slate-700">文件名（推断）</th>
                        <th className="px-2 py-2 text-left font-semibold text-slate-700">期望 MD5</th>
                        <th className="px-2 py-2 text-left font-semibold text-slate-700">本地索引大小</th>
                        <th className="px-2 py-2 text-left font-semibold text-slate-700">状态摘要</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {detailLines.map((line, idx) => (
                        <tr key={`${line.rowId}-${idx}`} className="hover:bg-slate-50/80">
                          <td className="px-2 py-1.5 text-slate-500 whitespace-nowrap">{idx + 1}</td>
                          <td className="px-2 py-1.5 text-slate-800 max-w-[14rem] truncate" title={line.displayName}>
                            {line.displayName}
                          </td>
                          <td className="px-2 py-1.5 font-mono text-[11px] text-slate-600">{line.md5 ?? '—'}</td>
                          <td className="px-2 py-1.5 whitespace-nowrap">{line.localSizeLabel ?? '—'}</td>
                          <td className="px-2 py-1.5 text-slate-700 max-w-[28rem]">
                            <div className="whitespace-pre-wrap break-words">{line.statusLine}</div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
};

