import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Loader2, Play, RefreshCcw, Workflow } from 'lucide-react';
import {
  fetchBomBatchById,
  fetchBomRows,
  type BomBatchRow,
} from '../lib/bomBatches';
import {
  extractComponentFromRow,
  extractDownloadUrlRaw,
  extractExpectedMd5FromRow,
  extractHttpUrlFromDownloadCell,
  fileBasename,
} from '../lib/bomRowFields';
import {
  defaultBomScannerConfig,
  fetchBomScannerSettings,
  type BomJsonKeyMap,
} from '../lib/bomScannerSettings';
import { fetchProductDistributionSettings } from '../lib/products';
import {
  assertPipelineDistributionReady,
  cancelBomSyncPipelineJob,
  fetchActiveBomSyncPipelineJob,
  pipelineJobToProgress,
  requestBomSyncPipeline,
  SYNC_PIPELINE_PHASE_LABEL,
  watchBomSyncPipeline,
  type SyncPipelinePhase,
  type SyncPipelineProgress,
} from '../lib/bomSyncPipeline';
import { formatSupabaseError } from '../lib/bomScannerJobs';
import { LABEL_EXTERNAL_ARTI } from '../lib/bomUiLabels';

const PHASE_ORDER: SyncPipelinePhase[] = [
  'enrich_md5',
  'download',
  'wait_verified',
  'ext_sync',
  'feishu_scan',
  'feishu_upload',
  'version_sheet',
  'done',
];

function rowLabel(row: BomBatchRow, keyMap: BomJsonKeyMap): string {
  const comp = extractComponentFromRow(row.bom_row, keyMap);
  if (comp?.trim()) return comp.trim();
  const raw = extractDownloadUrlRaw(row.bom_row, keyMap);
  const url = raw ? extractHttpUrlFromDownloadCell(raw) : null;
  if (url) return fileBasename(url) || url.slice(0, 48);
  return row.id.slice(0, 8);
}

export const BomSyncPipelinePage: React.FC = () => {
  const navigate = useNavigate();
  const params = useParams();
  const batchId = params.batchId ?? '';

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [batchName, setBatchName] = useState('');
  const [productName, setProductName] = useState('');
  const [productId, setProductId] = useState('');
  const [rows, setRows] = useState<BomBatchRow[]>([]);
  const [keyMap, setKeyMap] = useState<BomJsonKeyMap>(defaultBomScannerConfig.jsonKeyMap);
  const [extOk, setExtOk] = useState(false);
  const [feishuOk, setFeishuOk] = useState(false);

  const [doExt, setDoExt] = useState(true);
  const [doFeishu, setDoFeishu] = useState(true);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());

  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<SyncPipelineProgress | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [pipelineJobId, setPipelineJobId] = useState<string | null>(null);
  const watchAbortRef = useRef<AbortController | null>(null);
  const watchingIdRef = useRef<string | null>(null);
  const lastPhaseRef = useRef<SyncPipelinePhase>('idle');

  async function load(opts?: { resumePipeline?: boolean }) {
    if (!batchId) return;
    setLoading(true);
    setError(null);
    try {
      const [scanner, batch] = await Promise.all([
        fetchBomScannerSettings(),
        fetchBomBatchById(batchId),
      ]);
      if (!batch) throw new Error('未找到该版本');
      const dist = await fetchProductDistributionSettings(batch.productId);
      const list = await fetchBomRows(batchId);
      setKeyMap(scanner.jsonKeyMap);
      setBatchName(batch.name);
      setProductName(batch.productName ?? '');
      setProductId(batch.productId);
      setExtOk(Boolean(dist.extArtifactoryRepo.trim()));
      setFeishuOk(Boolean(dist.feishuDriveRootFolderToken.trim()));
      setRows(list);
      setSelectedIds((prev) => {
        const next = new Set<string>();
        for (const id of prev) {
          if (list.some((r) => r.id === id)) next.add(id);
        }
        return next;
      });
      const active = await fetchActiveBomSyncPipelineJob(batchId);
      if (opts?.resumePipeline !== false && active && watchingIdRef.current !== active.id) {
        setDoExt(active.doExt);
        setDoFeishu(active.doFeishu);
        setPipelineJobId(active.id);
        setProgress(pipelineJobToProgress(active, { batchName: batch.name, rowCount: list.length }));
        void attachWatch(active.id, batch.name);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    return () => {
      watchAbortRef.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batchId]);

  const visiblePhases = useMemo(
    () =>
      PHASE_ORDER.filter((p) => {
        if (p === 'done') return true;
        if (p === 'ext_sync') return doExt;
        if (p === 'feishu_scan' || p === 'feishu_upload' || p === 'version_sheet') return doFeishu;
        return true;
      }),
    [doExt, doFeishu],
  );

  const allSelected = rows.length > 0 && selectedIds.size === rows.length;
  const someSelected = selectedIds.size > 0 && selectedIds.size < rows.length;

  const scopeHint =
    selectedIds.size === 0
      ? `未勾选 → 整版 ${rows.length} 行`
      : `已勾选 ${selectedIds.size} / ${rows.length} 行`;

  const canStart =
    !busy &&
    !loading &&
    rows.length > 0 &&
    Boolean(productId) &&
    (!doExt || extOk) &&
    (!doFeishu || feishuOk);

  const toggleRow = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (allSelected) setSelectedIds(new Set());
    else setSelectedIds(new Set(rows.map((r) => r.id)));
  };

  async function attachWatch(jobId: string, name: string) {
    watchAbortRef.current?.abort();
    const ac = new AbortController();
    watchAbortRef.current = ac;
    watchingIdRef.current = jobId;
    setPipelineJobId(jobId);
    setBusy(true);
    setRunError(null);
    try {
      const job = await watchBomSyncPipeline(jobId, {
        signal: ac.signal,
        batchName: name,
        onProgress: (p) => {
          if (p.phase !== 'failed' && p.phase !== 'idle') lastPhaseRef.current = p.phase;
          setProgress(p);
        },
      });
      if (job.status === 'cancelled') {
        setProgress((prev) =>
          prev ? { ...prev, phase: 'failed', message: job.lastMessage || '已取消' } : { phase: 'failed', message: '已取消' },
        );
      } else if (job.status !== 'succeeded') {
        const msg = job.lastMessage?.trim() || '同步流水线失败';
        setRunError(msg);
        setProgress((prev) => (prev ? { ...prev, phase: 'failed', message: msg } : { phase: 'failed', message: msg }));
      }
      await load({ resumePipeline: false });
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') {
        return;
      }
      const msg = formatSupabaseError(e);
      setRunError(msg);
      setProgress((prev) => (prev ? { ...prev, phase: 'failed', message: msg } : { phase: 'failed', message: msg }));
    } finally {
      if (watchAbortRef.current === ac) {
        setBusy(false);
        watchAbortRef.current = null;
        watchingIdRef.current = null;
      }
    }
  }

  const handleStart = async () => {
    if (!canStart || !batchId) return;
    setRunError(null);
    setProgress(null);
    try {
      await assertPipelineDistributionReady(productId, { doExt, doFeishu });
      const existing = await fetchActiveBomSyncPipelineJob(batchId);
      if (existing) {
        setDoExt(existing.doExt);
        setDoFeishu(existing.doFeishu);
        setProgress(pipelineJobToProgress(existing, { batchName, rowCount: rows.length }));
        await attachWatch(existing.id, batchName || batchId);
        return;
      }
      const jobId = await requestBomSyncPipeline({
        batchId,
        rowIds: selectedIds.size > 0 ? [...selectedIds] : null,
        doExt,
        doFeishu,
        enrichMd5: true,
      });
      setProgress({
        phase: 'idle',
        message: '已入队，由后台 worker 编排。可关闭本页，进度见 BOM 任务页的子任务。',
        batchId,
        batchName,
        rowCount: selectedIds.size || rows.length,
        jobId,
      });
      await attachWatch(jobId, batchName || batchId);
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') {
        return;
      }
      const msg = formatSupabaseError(e);
      setRunError(msg);
      setProgress((prev) =>
        prev ? { ...prev, phase: 'failed', message: msg } : { phase: 'failed', message: msg },
      );
    }
  };

  const handleCancel = async () => {
    const id = pipelineJobId;
    if (!id) return;
    try {
      await cancelBomSyncPipelineJob(id);
    } catch (e) {
      setRunError(formatSupabaseError(e));
    }
  };

  const curIdx = progress
    ? visiblePhases.indexOf(
        progress.phase === 'failed' ? lastPhaseRef.current : (progress.phase as SyncPipelinePhase),
      )
    : -1;
  const failedAtIdx =
    progress?.phase === 'failed' ? visiblePhases.indexOf(lastPhaseRef.current) : -1;

  if (!batchId) {
    return (
      <div className="max-w-3xl mx-auto p-6 text-slate-600">
        <p>无效版本。</p>
        <button type="button" className="mt-4 text-indigo-700" onClick={() => navigate('/bom')}>
          返回 BOM 管理
        </button>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto space-y-5 pb-8">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3 min-w-0">
          <div className="w-10 h-10 rounded-lg bg-emerald-700 text-white flex items-center justify-center flex-shrink-0">
            <Workflow size={22} />
          </div>
          <div className="min-w-0">
            <button
              type="button"
              onClick={() => navigate('/bom')}
              className="inline-flex items-center gap-1.5 text-slate-600 hover:text-slate-800 text-sm"
            >
              <ArrowLeft size={16} />
              BOM 管理
            </button>
            <h2 className="text-2xl font-bold text-slate-900 mt-1">一键同步</h2>
            <p className="text-slate-500 mt-1 text-sm">
              本地拉取必选；{LABEL_EXTERNAL_ARTI} / 飞书可勾选。任务由后台 worker 编排，关闭本页不会中断。
              未勾选行 = 整版；有勾选 = 只跑勾选行。
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={busy || loading}
          className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50 shrink-0 disabled:opacity-50"
        >
          <RefreshCcw size={16} />
          刷新
        </button>
      </div>

      <div className="rounded-xl border border-emerald-200 bg-gradient-to-r from-emerald-50 via-white to-slate-50 px-5 py-4">
        <div className="flex flex-wrap gap-x-10 gap-y-3">
          <div>
            <div className="text-xs font-semibold text-emerald-700 uppercase tracking-wide">产品</div>
            <div className="mt-1 text-xl font-bold text-slate-900">{loading ? '…' : productName || '—'}</div>
          </div>
          <div>
            <div className="text-xs font-semibold text-emerald-700 uppercase tracking-wide">版本</div>
            <div className="mt-1 text-xl font-bold text-slate-900">{loading ? '…' : batchName || '—'}</div>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap gap-3 text-sm">
          <button
            type="button"
            className="text-indigo-700 hover:text-indigo-900"
            onClick={() => navigate(`/bom/${batchId}`)}
          >
            查看/编辑
          </button>
          <button
            type="button"
            className="text-indigo-700 hover:text-indigo-900"
            onClick={() => navigate(`/bom/${batchId}/distribute`)}
          >
            打开分发页
          </button>
          <button
            type="button"
            className="text-indigo-700 hover:text-indigo-900"
            onClick={() => navigate(`/bom/jobs?batchId=${encodeURIComponent(batchId)}`)}
          >
            打开 BOM 任务
          </button>
        </div>
      </div>

      {error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      ) : null}

      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 space-y-4">
        <div>
          <div className="text-sm font-medium text-slate-800 mb-2">同步阶段</div>
          <div className="flex flex-wrap gap-4 text-sm text-slate-700">
            <label className="inline-flex items-center gap-2 opacity-80">
              <input type="checkbox" checked disabled className="h-4 w-4 rounded border-gray-300" />
              本地拉取（必选）
            </label>
            <label className="inline-flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={doExt}
                disabled={busy}
                onChange={(e) => setDoExt(e.target.checked)}
                className="h-4 w-4 rounded border-gray-300 text-emerald-600"
              />
              {LABEL_EXTERNAL_ARTI}
              {!extOk ? <span className="text-amber-700 text-xs">（产品未配置仓库）</span> : null}
            </label>
            <label className="inline-flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={doFeishu}
                disabled={busy}
                onChange={(e) => setDoFeishu(e.target.checked)}
                className="h-4 w-4 rounded border-gray-300 text-emerald-600"
              />
              飞书（扫描 / 上传 / 清单）
              {!feishuOk ? <span className="text-amber-700 text-xs">（产品未配置飞书根目录）</span> : null}
            </label>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-sm text-slate-600">
            同步范围：<span className="font-medium text-slate-900">{scopeHint}</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={busy || rows.length === 0}
              onClick={toggleAll}
              className="text-xs font-medium text-indigo-700 hover:text-indigo-900 disabled:text-slate-400"
            >
              {allSelected ? '清除勾选' : '全选'}
            </button>
            <button
              type="button"
              disabled={!canStart}
              onClick={() => void handleStart()}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-700 text-white text-sm font-medium hover:bg-emerald-800 disabled:opacity-50"
            >
              {busy ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} />}
              {busy ? '同步中…' : '开始同步'}
            </button>
            {busy && pipelineJobId ? (
              <button
                type="button"
                onClick={() => void handleCancel()}
                className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-slate-300 text-sm text-slate-700 hover:bg-slate-50"
              >
                取消同步
              </button>
            ) : null}
          </div>
        </div>

        <div className="overflow-x-auto border border-gray-200 rounded-lg max-h-[28rem]">
          <table className="min-w-full text-xs">
            <thead className="bg-slate-50 sticky top-0">
              <tr>
                <th className="px-3 py-2 text-center w-10 border-b">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    ref={(el) => {
                      if (el) el.indeterminate = someSelected;
                    }}
                    onChange={toggleAll}
                    disabled={busy || rows.length === 0}
                    className="h-3.5 w-3.5 rounded border-slate-400 text-emerald-600"
                    title="全选 / 清除（未勾选时跑整版）"
                  />
                </th>
                <th className="px-3 py-2 text-left font-semibold text-slate-700 border-b">#</th>
                <th className="px-3 py-2 text-left font-semibold text-slate-700 border-b">组件 / 文件</th>
                <th className="px-3 py-2 text-left font-semibold text-slate-700 border-b">MD5</th>
                <th className="px-3 py-2 text-left font-semibold text-slate-700 border-b">本地</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading ? (
                <tr>
                  <td colSpan={5} className="px-3 py-8 text-center text-slate-500">
                    加载中…
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-3 py-8 text-center text-slate-500">
                    当前版本无数据行
                  </td>
                </tr>
              ) : (
                rows.map((r, i) => {
                  const md5 = extractExpectedMd5FromRow(r.bom_row, keyMap);
                  return (
                    <tr key={r.id} className="hover:bg-slate-50/80">
                      <td className="px-3 py-2 text-center">
                        <input
                          type="checkbox"
                          checked={selectedIds.has(r.id)}
                          disabled={busy}
                          onChange={() => toggleRow(r.id)}
                          className="h-3.5 w-3.5 rounded border-slate-400 text-emerald-600"
                        />
                      </td>
                      <td className="px-3 py-2 text-slate-500">{i + 1}</td>
                      <td className="px-3 py-2 text-slate-800 max-w-xs truncate" title={rowLabel(r, keyMap)}>
                        {rowLabel(r, keyMap)}
                      </td>
                      <td className="px-3 py-2 font-mono text-slate-600">
                        {md5 ? `${md5.slice(0, 8)}…` : <span className="text-amber-700">缺</span>}
                      </td>
                      <td className="px-3 py-2 text-slate-600">{r.status.local}</td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {progress ? (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 space-y-3">
          <div className="text-sm font-medium text-slate-800">进度</div>
          <ol className="space-y-2">
            {visiblePhases.filter((p) => p !== 'done').map((p) => {
              const idx = visiblePhases.indexOf(p);
              const failed = failedAtIdx === idx;
              const done = progress.phase === 'done' || (curIdx >= 0 && idx < curIdx && !failed);
              const active =
                !failed &&
                progress.phase !== 'done' &&
                progress.phase !== 'failed' &&
                progress.phase === p;
              return (
                <li
                  key={p}
                  className={`flex items-center gap-2 text-sm ${
                    failed
                      ? 'text-rose-700'
                      : done
                        ? 'text-emerald-700'
                        : active
                          ? 'text-emerald-800 font-medium'
                          : 'text-slate-400'
                  }`}
                >
                  <span className="w-5 text-center">
                    {failed ? '✕' : done ? '✓' : active && busy ? '…' : '○'}
                  </span>
                  {SYNC_PIPELINE_PHASE_LABEL[p]}
                </li>
              );
            })}
            {progress.phase === 'done' ? (
              <li className="flex items-center gap-2 text-sm text-emerald-700 font-medium">
                <span className="w-5 text-center">✓</span>
                {SYNC_PIPELINE_PHASE_LABEL.done}
              </li>
            ) : null}
          </ol>
          <p className="text-sm text-slate-600 border-t border-slate-100 pt-3 whitespace-pre-wrap">
            {progress.message}
          </p>
          {busy ? (
            <p className="text-xs text-slate-500">
              关闭或刷新本页不会中断后台任务。子任务进度请到{' '}
              <button
                type="button"
                className="text-indigo-700 hover:text-indigo-900"
                onClick={() => navigate(`/bom/jobs?batchId=${encodeURIComponent(batchId)}`)}
              >
                BOM 任务
              </button>
              查看。
            </p>
          ) : null}
        </div>
      ) : null}

      {runError ? (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 whitespace-pre-wrap">
          {runError}
        </div>
      ) : null}
    </div>
  );
};
