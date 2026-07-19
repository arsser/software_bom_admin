import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Loader2, PackagePlus } from 'lucide-react';
import { fetchProducts, type Product } from '../lib/products';
import {
  createPatchBatchAndRunPipeline,
  parseArtifactoryUrlsFromText,
  PATCH_PIPELINE_PHASE_LABEL,
  suggestedPatchBatchName,
  type PatchPipelinePhase,
  type PatchPipelineProgress,
} from '../lib/bomPatchFromUrls';
import { formatSupabaseError } from '../lib/bomScannerJobs';
import { LABEL_EXTERNAL_ARTI } from '../lib/bomUiLabels';

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

function phaseIndex(phase: PatchPipelinePhase): number {
  if (phase === 'idle') return -1;
  if (phase === 'failed') return -2;
  return PHASE_ORDER.indexOf(phase);
}

export const BomPatchUploadPage: React.FC = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const presetProductId = searchParams.get('productId')?.trim() ?? '';

  const [products, setProducts] = useState<Product[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [productId, setProductId] = useState(presetProductId);
  const [batchName, setBatchName] = useState(() => suggestedPatchBatchName());
  const [arch, setArch] = useState('');
  const [urlsText, setUrlsText] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<PatchPipelineProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [doneBatchId, setDoneBatchId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const lastWorkingPhaseRef = useRef<PatchPipelinePhase>('idle');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await fetchProducts();
        if (cancelled) return;
        setProducts(list);
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
  const selectedProduct = products.find((p) => p.id === productId) ?? null;
  const distOk = Boolean(
    selectedProduct?.extArtifactoryRepo.trim() && selectedProduct?.feishuDriveRootFolderToken.trim(),
  );

  const canSubmit =
    !busy &&
    Boolean(productId) &&
    distOk &&
    batchName.trim().length > 0 &&
    arch.trim().length > 0 &&
    description.trim().length > 0 &&
    urlPreview.urls.length > 0 &&
    urlPreview.errors.length === 0;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setError(null);
    setDoneBatchId(null);
    setBusy(true);
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const result = await createPatchBatchAndRunPipeline({
        productId,
        batchName: batchName.trim(),
        urls: urlPreview.urls,
        description: description.trim(),
        arch: arch.trim(),
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
        message: result.versionSheetUrl
          ? `完成：版本「${result.batchName}」，共 ${result.rowCount} 个包；清单 ${result.versionSheetUrl}`
          : `完成：版本「${result.batchName}」，共 ${result.rowCount} 个包；软件包清单已生成`,
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
      abortRef.current = null;
    }
  };

  const handleCancel = () => {
    abortRef.current?.abort();
  };

  const curIdx = progress
    ? phaseIndex(progress.phase === 'failed' ? lastWorkingPhaseRef.current : progress.phase)
    : -1;
  const failedAtIdx =
    progress?.phase === 'failed' ? phaseIndex(lastWorkingPhaseRef.current) : -1;

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
            填写 Artifactory 链接与说明，系统将新建 Hot fix 版本并自动完成：本地拉取 → {LABEL_EXTERNAL_ARTI} →
            飞书（可全局去重）→ 生成版本「软件包清单」。
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
              请先在产品编辑中配置 {LABEL_EXTERNAL_ARTI} 仓库与飞书根目录。
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
          <p className="mt-1 text-xs text-slate-500">
            将作为 {LABEL_EXTERNAL_ARTI} 与飞书下的一级目录名。
          </p>
        </div>

        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">硬件平台</label>
          <input
            type="text"
            value={arch}
            onChange={(e) => setArch(e.target.value)}
            disabled={busy}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm disabled:opacity-60"
            placeholder="例如：x86_T4 / arm_NPU40T / common"
            list="bom-patch-arch-suggestions"
          />
          <datalist id="bom-patch-arch-suggestions">
            <option value="x86_T4" />
            <option value="arm_NPU40T" />
            <option value="arm_NPU10T" />
            <option value="common" />
          </datalist>
          <p className="mt-1 text-xs text-slate-500">写入各行「硬件平台」列，参与本地命名区分。</p>
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

        <div className="flex items-center gap-2 pt-1">
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {busy ? <Loader2 size={16} className="animate-spin" /> : <PackagePlus size={16} />}
            {busy ? '处理中…' : '创建并自动同步'}
          </button>
          {busy ? (
            <button
              type="button"
              onClick={handleCancel}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-slate-300 text-slate-700 text-sm hover:bg-slate-50"
            >
              取消等待
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
      </div>

      {progress ? (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 space-y-3">
          <div className="text-sm font-medium text-slate-800">进度</div>
          <ol className="space-y-2">
            {PHASE_ORDER.filter((p) => p !== 'done').map((p) => {
              const idx = PHASE_ORDER.indexOf(p);
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
