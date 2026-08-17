import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Loader2, PackagePlus } from 'lucide-react';
import { fetchProducts, type Product } from '../lib/products';
import {
  createPatchBatchAndRunPipeline,
  createPatchBatchOnly,
  parseArtifactoryUrlsFromText,
  PATCH_PIPELINE_PHASE_LABEL,
  suggestedPatchBatchName,
  type PatchPipelinePhase,
  type PatchPipelineProgress,
} from '../lib/bomPatchFromUrls';
import { formatSupabaseError } from '../lib/bomScannerJobs';
import { DEFAULT_ARCH_OPTIONS, fetchBomScannerSettings } from '../lib/bomScannerSettings';
import { LABEL_EXTERNAL_ARTI } from '../lib/bomUiLabels';
import { cancelBomSyncPipelineJob } from '../lib/bomSyncPipeline';

const PHASE_ORDER: PatchPipelinePhase[] = [
  'create_batch',
  'enrich_md5',
  'download',
  'wait_verified',
  'ext_sync',
  'feishu_scan',
  'feishu_upload',
  'version_sheet',
  'done',
];

function phaseIndex(phase: PatchPipelinePhase, order: PatchPipelinePhase[]): number {
  if (phase === 'idle') return -1;
  if (phase === 'failed') return -2;
  return order.indexOf(phase);
}

export const BomPatchUploadPage: React.FC = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const presetProductId = searchParams.get('productId')?.trim() ?? '';

  const [products, setProducts] = useState<Product[]>([]);
  const [archOptions, setArchOptions] = useState<string[]>([...DEFAULT_ARCH_OPTIONS]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [productId, setProductId] = useState(presetProductId);
  const [batchName, setBatchName] = useState(() => suggestedPatchBatchName());
  const [defaultArch, setDefaultArch] = useState('');
  const [urlArchMap, setUrlArchMap] = useState<Record<string, string>>({});
  const [urlsText, setUrlsText] = useState('');
  const [description, setDescription] = useState('');
  const [doExt, setDoExt] = useState(true);
  const [doFeishu, setDoFeishu] = useState(true);
  const [busy, setBusy] = useState(false);
  /** create = 仅创建；pipeline = 创建并同步 */
  const [busyMode, setBusyMode] = useState<'create' | 'pipeline' | null>(null);
  /** 最近一次操作模式（用于进度条展示；busy 结束后仍保留） */
  const [lastMode, setLastMode] = useState<'create' | 'pipeline' | null>(null);
  const [progress, setProgress] = useState<PatchPipelineProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [doneBatchId, setDoneBatchId] = useState<string | null>(null);
  const [pipelineJobId, setPipelineJobId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const lastWorkingPhaseRef = useRef<PatchPipelinePhase>('idle');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [list, scanner] = await Promise.all([fetchProducts(), fetchBomScannerSettings()]);
        if (cancelled) return;
        setProducts(list);
        setArchOptions(scanner.archOptions.length ? scanner.archOptions : [...DEFAULT_ARCH_OPTIONS]);
        if (!presetProductId && list.length === 1) {
          setProductId(list[0].id);
        } else if (presetProductId && list.some((p) => p.id === presetProductId)) {
          setProductId(presetProductId);
        }
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [presetProductId]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const urlPreview = useMemo(() => parseArtifactoryUrlsFromText(urlsText), [urlsText]);

  useEffect(() => {
    setUrlArchMap((prev) => {
      const next: Record<string, string> = {};
      for (const u of urlPreview.urls) {
        next[u] = prev[u] || defaultArch || (archOptions[0] ?? '');
      }
      return next;
    });
  }, [urlPreview.urls.join('\n'), defaultArch, archOptions.join('|')]);

  const selectedProduct = products.find((p) => p.id === productId) ?? null;
  const extOk = Boolean(selectedProduct?.extArtifactoryRepo.trim());
  const feishuOk = Boolean(selectedProduct?.feishuDriveRootFolderToken.trim());
  const distOk = (!doExt || extOk) && (!doFeishu || feishuOk);

  const visiblePhases = useMemo(() => {
    const mode = busyMode ?? lastMode;
    if (mode === 'create') {
      return (['create_batch', 'done'] as PatchPipelinePhase[]);
    }
    return PHASE_ORDER.filter((p) => {
      if (p === 'done') return true;
      if (p === 'ext_sync') return doExt;
      if (p === 'feishu_scan' || p === 'feishu_upload' || p === 'version_sheet') return doFeishu;
      return true;
    });
  }, [doExt, doFeishu, busyMode, lastMode]);

  const allUrlsHaveArch = urlPreview.urls.every((u) => (urlArchMap[u] ?? '').trim().length > 0);

  /** 仅创建：不校验分发配置 */
  const createOnlyBlockReasons = useMemo(() => {
    const reasons: string[] = [];
    if (busy) reasons.push('正在处理中');
    if (!productId) reasons.push('请选择产品');
    if (!batchName.trim()) reasons.push('请填写版本名称');
    if (urlPreview.urls.length === 0) reasons.push('请至少填写一条有效的 Artifactory 链接');
    if (urlPreview.errors.length > 0) reasons.push(`链接解析错误：${urlPreview.errors[0]}`);
    if (urlPreview.urls.length > 0 && !allUrlsHaveArch) {
      reasons.push('请为每条链接选择硬件平台（或先选「默认硬件平台」）');
    }
    if (!description.trim()) reasons.push('请填写说明（写入备注）');
    return reasons;
  }, [
    busy,
    productId,
    batchName,
    urlPreview.urls.length,
    urlPreview.errors,
    allUrlsHaveArch,
    description,
  ]);

  const submitBlockReasons = useMemo(() => {
    const reasons = [...createOnlyBlockReasons];
    if (doExt && !extOk) reasons.push(`产品未配置 ${LABEL_EXTERNAL_ARTI} 仓库`);
    if (doFeishu && !feishuOk) reasons.push('产品未配置飞书根目录');
    return reasons;
  }, [createOnlyBlockReasons, doExt, doFeishu, extOk, feishuOk]);

  const canCreateOnly = createOnlyBlockReasons.length === 0;
  const canSubmit = submitBlockReasons.length === 0;

  // 选项加载后若未选手动默认平台，自动选第一项，避免「有链接但无平台」导致按钮一直灰
  useEffect(() => {
    if (!defaultArch && archOptions.length > 0) {
      setDefaultArch(archOptions[0]);
    }
  }, [archOptions, defaultArch]);

  const patchInputBase = () => ({
    productId,
    batchName: batchName.trim(),
    urls: urlPreview.urls.map((url) => ({
      url,
      arch: (urlArchMap[url] || defaultArch || '').trim(),
    })),
    description: description.trim(),
  });

  const handleCreateOnly = async () => {
    if (!canCreateOnly) {
      setError(createOnlyBlockReasons.join('；'));
      return;
    }
    setError(null);
    setDoneBatchId(null);
    setBusy(true);
    setBusyMode('create');
    setLastMode('create');
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const result = await createPatchBatchOnly({
        ...patchInputBase(),
        signal: ac.signal,
        onProgress: (p) => {
          if (p.phase !== 'failed' && p.phase !== 'idle') {
            lastWorkingPhaseRef.current = p.phase;
          }
          setProgress(p);
        },
      });
      setDoneBatchId(result.batchId);
      setProgress({
        phase: 'done',
        message: `已创建版本「${result.batchName}」，共 ${result.rowCount} 个包（未同步）`,
        batchId: result.batchId,
        batchName: result.batchName,
        rowCount: result.rowCount,
      });
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') {
        setProgress((prev) => ({
          phase: 'failed',
          message: '已取消',
          batchId: prev?.batchId,
          batchName: prev?.batchName,
          rowCount: prev?.rowCount,
        }));
      } else {
        const msg = formatSupabaseError(e);
        setError(msg);
        setProgress((prev) => ({
          phase: 'failed',
          message: msg,
          batchId: prev?.batchId,
          batchName: prev?.batchName,
          rowCount: prev?.rowCount,
        }));
      }
    } finally {
      setBusy(false);
      setBusyMode(null);
      abortRef.current = null;
    }
  };

  const handleSubmit = async () => {
    if (!canSubmit) {
      setError(submitBlockReasons.join('；'));
      return;
    }
    setError(null);
    setDoneBatchId(null);
    setPipelineJobId(null);
    setBusy(true);
    setBusyMode('pipeline');
    setLastMode('pipeline');
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const result = await createPatchBatchAndRunPipeline({
        ...patchInputBase(),
        doExt,
        doFeishu,
        signal: ac.signal,
        onProgress: (p) => {
          if (p.phase !== 'failed' && p.phase !== 'idle') {
            lastWorkingPhaseRef.current = p.phase;
          }
          if (p.batchId) setDoneBatchId(p.batchId);
          if (p.jobId) setPipelineJobId(p.jobId);
          setProgress(p);
        },
      });
      setDoneBatchId(result.batchId);
      setProgress({
        phase: 'done',
        message: result.versionSheetUrl
          ? `完成：版本「${result.batchName}」，共 ${result.rowCount} 个包；清单 ${result.versionSheetUrl}`
          : `完成：版本「${result.batchName}」，共 ${result.rowCount} 个包。可关闭本页，子任务见 BOM 任务。`,
        batchId: result.batchId,
        batchName: result.batchName,
        rowCount: result.rowCount,
        jobId: result.pipelineJobId,
      });
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') {
        return;
      } else {
        const msg = formatSupabaseError(e);
        setError(msg);
        setProgress((prev) => ({
          phase: 'failed',
          message: msg,
          batchId: prev?.batchId,
          batchName: prev?.batchName,
          rowCount: prev?.rowCount,
        }));
      }
    } finally {
      setBusy(false);
      setBusyMode(null);
      abortRef.current = null;
    }
  };

  const handleCancel = () => {
    const id = pipelineJobId;
    if (busyMode === 'pipeline' && id) {
      void cancelBomSyncPipelineJob(id).catch((e) => setError(formatSupabaseError(e)));
      return;
    }
    abortRef.current?.abort();
  };

  const curIdx = progress
    ? phaseIndex(progress.phase === 'failed' ? lastWorkingPhaseRef.current : progress.phase, visiblePhases)
    : -1;
  const failedAtIdx =
    progress?.phase === 'failed' ? phaseIndex(lastWorkingPhaseRef.current, visiblePhases) : -1;

  return (
    <div className="max-w-3xl mx-auto space-y-5 pb-8">
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-lg bg-indigo-600 text-white flex items-center justify-center flex-shrink-0">
          <PackagePlus size={22} />
        </div>
        <div className="min-w-0 flex-1">
          <button
            type="button"
            onClick={() => navigate('/bom')}
            className="inline-flex items-center gap-1.5 text-slate-600 hover:text-slate-800 text-sm"
          >
            <ArrowLeft size={16} />
            返回 BOM 管理
          </button>
          <h2 className="text-2xl font-bold text-slate-900 mt-1">Hot fix</h2>
          <p className="text-slate-500 mt-1 text-sm">
            填写 Artifactory 链接与每条链接的硬件平台；本地拉取必选，{LABEL_EXTERNAL_ARTI} / 飞书可勾选。
            自动同步由后台 worker 编排，关闭本页不会中断。
          </p>
        </div>
      </div>

      {loadError ? (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          加载产品失败：{loadError}
        </div>
      ) : null}

      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 space-y-4">
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">产品</label>
          <select
            value={productId}
            onChange={(e) => setProductId(e.target.value)}
            disabled={busy}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm bg-white disabled:opacity-60"
          >
            <option value="">请选择产品</option>
            {products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {!p.extArtifactoryRepo.trim() || !p.feishuDriveRootFolderToken.trim()
                  ? '（分发配置未完整）'
                  : ''}
              </option>
            ))}
          </select>
          {selectedProduct && !distOk ? (
            <p className="mt-1 text-xs text-amber-700">
              {doExt && !extOk ? `请配置 ${LABEL_EXTERNAL_ARTI} 仓库。` : null}
              {doFeishu && !feishuOk ? '请配置飞书根目录。' : null}
            </p>
          ) : null}
        </div>

        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Hot fix 版本名称</label>
          <input
            type="text"
            value={batchName}
            onChange={(e) => setBatchName(e.target.value)}
            disabled={busy}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm disabled:opacity-60"
            placeholder={suggestedPatchBatchName()}
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">默认同步阶段</label>
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
                className="h-4 w-4 rounded border-gray-300 text-indigo-600"
              />
              {LABEL_EXTERNAL_ARTI}
            </label>
            <label className="inline-flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={doFeishu}
                disabled={busy}
                onChange={(e) => setDoFeishu(e.target.checked)}
                className="h-4 w-4 rounded border-gray-300 text-indigo-600"
              />
              飞书（扫描 / 上传 / 清单）
            </label>
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">默认硬件平台</label>
          <select
            value={defaultArch}
            onChange={(e) => setDefaultArch(e.target.value)}
            disabled={busy}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm bg-white disabled:opacity-60"
          >
            <option value="">（请选择，将应用到新解析的链接）</option>
            {archOptions.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-slate-500">选项来自系统设置；可在下方为每条链接单独修改。</p>
        </div>

        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">
            Artifactory 链接（每行一个）
          </label>
          <textarea
            value={urlsText}
            onChange={(e) => setUrlsText(e.target.value)}
            disabled={busy}
            rows={6}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono disabled:opacity-60"
            placeholder={
              'https://it-artifactory.example.com/artifactory/.../pkg.tar.gz\n# 可用 # 注释；支持 markdown 链接'
            }
          />
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs">
            <span className="text-slate-500">有效链接：{urlPreview.urls.length}</span>
            {urlPreview.errors.length > 0 ? (
              <span className="text-rose-600">解析错误：{urlPreview.errors[0]}</span>
            ) : null}
          </div>
        </div>

        {urlPreview.urls.length > 0 ? (
          <div className="rounded-lg border border-slate-200 overflow-hidden">
            <div className="px-3 py-2 bg-slate-50 text-xs font-medium text-slate-600">
              每条链接的硬件平台
            </div>
            <ul className="divide-y divide-slate-100 max-h-64 overflow-y-auto">
              {urlPreview.urls.map((u) => (
                <li key={u} className="px-3 py-2 flex flex-col sm:flex-row sm:items-center gap-2">
                  <div className="min-w-0 flex-1 text-xs font-mono text-slate-700 truncate" title={u}>
                    {u}
                  </div>
                  <select
                    value={urlArchMap[u] || ''}
                    onChange={(e) =>
                      setUrlArchMap((prev) => ({
                        ...prev,
                        [u]: e.target.value,
                      }))
                    }
                    disabled={busy}
                    className="sm:w-44 rounded-md border border-slate-300 px-2 py-1.5 text-sm bg-white disabled:opacity-60"
                  >
                    <option value="">选择平台</option>
                    {archOptions.map((a) => (
                      <option key={a} value={a}>
                        {a}
                      </option>
                    ))}
                  </select>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">说明（写入备注）</label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            disabled={busy}
            rows={3}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm disabled:opacity-60"
            placeholder="例如：现场紧急修复包 / 对应工单号 / 适用范围"
          />
        </div>

        <div className="pt-1 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void handleCreateOnly()}
              disabled={busy}
              title={
                !canCreateOnly && createOnlyBlockReasons.length
                  ? createOnlyBlockReasons.join('；')
                  : '仅创建 Hot fix 版本，不跑本地/ext/飞书同步'
              }
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-indigo-300 bg-white text-indigo-800 text-sm font-medium hover:bg-indigo-50 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {busy && busyMode === 'create' ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <PackagePlus size={16} />
              )}
              {busy && busyMode === 'create' ? '创建中…' : '创建'}
            </button>
            <button
              type="button"
              onClick={() => void handleSubmit()}
              disabled={busy}
              title={
                !canSubmit && submitBlockReasons.length
                  ? submitBlockReasons.join('；')
                  : undefined
              }
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {busy && busyMode === 'pipeline' ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <PackagePlus size={16} />
              )}
              {busy && busyMode === 'pipeline' ? '处理中…' : '创建并自动同步'}
            </button>
            {busy ? (
              <button
                type="button"
                onClick={handleCancel}
                className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-slate-300 text-slate-700 text-sm hover:bg-slate-50"
              >
                取消同步
              </button>
            ) : null}
            {doneBatchId ? (
              <>
                <button
                  type="button"
                  onClick={() => navigate(`/bom/${doneBatchId}`)}
                  className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-indigo-200 bg-indigo-50 text-indigo-700 text-sm hover:bg-indigo-100"
                >
                  打开版本详情
                </button>
                <button
                  type="button"
                  onClick={() => navigate(`/bom/jobs?batchId=${encodeURIComponent(doneBatchId)}`)}
                  className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-slate-300 text-slate-700 text-sm hover:bg-slate-50"
                >
                  打开 BOM 任务
                </button>
                <button
                  type="button"
                  onClick={() => navigate(`/bom/${doneBatchId}/sync`)}
                  className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-emerald-300 text-emerald-800 text-sm hover:bg-emerald-50"
                >
                  去一键同步
                </button>
                <button
                  type="button"
                  onClick={() => navigate(`/bom/${doneBatchId}/distribute`)}
                  className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-slate-300 text-slate-700 text-sm hover:bg-slate-50"
                >
                  打开分发页
                </button>
              </>
            ) : progress?.batchId && progress.phase === 'failed' ? (
              <button
                type="button"
                onClick={() => navigate(`/bom/${progress.batchId}`)}
                className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-amber-200 bg-amber-50 text-amber-800 text-sm hover:bg-amber-100"
              >
                打开已创建版本
              </button>
            ) : null}
          </div>
          <p className="text-xs text-slate-500">
            「创建」只建版本；「创建并自动同步」入队后台编排。关闭页面不会中断，进度见 BOM 任务。
          </p>
          {!busy && !canSubmit && submitBlockReasons.length > 0 ? (
            <ul className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 space-y-0.5 list-disc list-inside">
              {submitBlockReasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>

      {progress ? (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 space-y-3">
          <div className="text-sm font-medium text-slate-800">进度</div>
          <ol className="space-y-2">
            {visiblePhases.filter((p) => p !== 'done').map((p) => {
              const idx = visiblePhases.indexOf(p);
              const failed = failedAtIdx === idx;
              const done =
                progress.phase === 'done' || (curIdx >= 0 && idx < curIdx && !failed);
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
                          ? 'text-indigo-700 font-medium'
                          : 'text-slate-400'
                  }`}
                >
                  <span className="w-5 text-center">
                    {failed ? '✕' : done ? '✓' : active && busy ? '…' : '○'}
                  </span>
                  {PATCH_PIPELINE_PHASE_LABEL[p]}
                </li>
              );
            })}
            {progress.phase === 'done' ? (
              <li className="flex items-center gap-2 text-sm text-emerald-700 font-medium">
                <span className="w-5 text-center">✓</span>
                {PATCH_PIPELINE_PHASE_LABEL.done}
              </li>
            ) : null}
          </ol>
          <p className="text-sm text-slate-600 border-t border-slate-100 pt-3">{progress.message}</p>
        </div>
      ) : null}

      {error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 whitespace-pre-wrap">
          {error}
        </div>
      ) : null}
    </div>
  );
};
