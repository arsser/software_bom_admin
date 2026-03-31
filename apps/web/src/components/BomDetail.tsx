import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowLeft,
  ClipboardCopy,
  HardDriveDownload,
  Download,
  Loader2,
  Package,
  RefreshCcw,
  Save,
  Trash2,
  XCircle,
} from 'lucide-react';
import { defaultBomScannerConfig, fetchBomScannerSettings, type BomScannerConfig } from '../lib/bomScannerSettings';
import {
  buildBomWarnings,
  createBatchWithRows,
  fetchBomBatchById,
  fetchBomRows,
  fetchLocalFileInfoByMd5,
  type LocalFileIndexInfo,
  mergeHeaderOrder,
  parsePastedBom,
  parsePastedFromClipboard,
  replaceBatchRows,
  updateBomBatchHeaderOrder,
  updateBomRowRecord,
  validateRequiredHeaders,
  type BomBatchRow,
  type BomRowRecord,
} from '../lib/bomBatches';
import { enrichBomRowsFromArtifactory } from '../lib/bomArtifactoryEnrich';
import { fetchArtifactorySettings, type ArtifactoryConfig } from '../lib/artifactorySettings';
import {
  BOM_DOWNLOAD_JOB_STATUS_LABEL,
  cancelBomDownloadJob,
  downloadJobIsTerminal,
  downloadJobProgressPercent,
  fetchBomDownloadJobsForBatch,
  formatDownloadJobBytesLine,
  requestBomItDownload,
  type BomDownloadJob,
} from '../lib/bomDownloadJobs';
import {
  buildCopyCommandsForRows,
  rowHasArtifactoryHttpUrl,
} from '../lib/bomDownloadCommands';
import {
  extractExpectedMd5FromRow,
  extractRemoteSizeBytesFromRow,
  extractRemarkFromRow,
  fileBasename,
  headerMatchesAny,
  rowEligibleForItPull,
} from '../lib/bomRowFields';
import { BomRowByteSizeCell } from './HumanByteSize';
import { BomDataTableCell, headerIsDownloadColumn, headerIsMd5Column } from '../lib/bomTableCell';
import {
  BOM_ROW_STATUS_LABEL,
  BOM_STATUS_LEGEND_ERROR,
  BOM_STATUS_LEGEND_MANUAL,
  BOM_STATUS_LEGEND_PENDING,
  BOM_STATUS_LEGEND_VERIFIED_OK,
} from '../lib/bomRowStatus';
import {
  createProduct,
  fetchProducts,
  type Product,
} from '../lib/products';

export const BomDetail: React.FC = () => {
  const navigate = useNavigate();
  const params = useParams();
  const [searchParams] = useSearchParams();

  const batchId = params.batchId ?? null;
  const isNew = batchId === null;

  const [config, setConfig] = useState<BomScannerConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saveLoading, setSaveLoading] = useState(false);

  const [batchName, setBatchName] = useState('');
  const [selectedProductId, setSelectedProductId] = useState('');
  const [products, setProducts] = useState<Product[]>([]);
  const [newProductName, setNewProductName] = useState('');

  const [pastedText, setPastedText] = useState('');
  const [selectedRows, setSelectedRows] = useState<BomRowRecord[]>([]);
  const [loadedBomRows, setLoadedBomRows] = useState<BomBatchRow[]>([]);
  const [batchHeaderOrder, setBatchHeaderOrder] = useState<string[]>([]);
  const [lastMessage, setLastMessage] = useState<string>('');

  const [previewRows, setPreviewRows] = useState<BomRowRecord[]>([]);
  const [previewHeaders, setPreviewHeaders] = useState<string[]>([]);
  const [showRawInput, setShowRawInput] = useState(false);
  const [previewHeaderError, setPreviewHeaderError] = useState<string>('');
  const [artifactoryConfig, setArtifactoryConfig] = useState<ArtifactoryConfig | null>(null);
  const [localInfoByMd5, setLocalInfoByMd5] = useState<Map<string, LocalFileIndexInfo>>(() => new Map());
  const [artifactoryEnrichLoading, setArtifactoryEnrichLoading] = useState(false);
  const [downloadJobs, setDownloadJobs] = useState<BomDownloadJob[]>([]);
  /** 'all' | 行 id | null */
  const [downloadBusy, setDownloadBusy] = useState<'all' | string | null>(null);
  const [downloadCancelBusy, setDownloadCancelBusy] = useState(false);
  const downloadJobStatusRef = useRef<Map<string, string>>(new Map());
  /** 已入库表格：勾选用于复制 curl/wget 的行 id */
  const [copyRowIds, setCopyRowIds] = useState<Set<string>>(() => new Set());
  const [copyCmdToast, setCopyCmdToast] = useState<string | null>(null);

  const pasteAreaRef = useRef<HTMLDivElement>(null);
  const PASTE_AREA_HINT = '在此处 Ctrl/Cmd+V 粘贴 Excel 区域';

  const headerExampleCells = useMemo(() => {
    const jm = config?.jsonKeyMap ?? defaultBomScannerConfig.jsonKeyMap;
    const downloadLabel = jm.downloadUrl[0] ?? '下载路径';
    const md5Label = jm.expectedMd5[0] ?? 'MD5';
    return ['…', '…', downloadLabel, '…', md5Label, '…'] as const;
  }, [config]);

  const selectedWarnings = useMemo(() => {
    if (!config) return [];
    return buildBomWarnings(selectedRows, config.jsonKeyMap);
  }, [config, selectedRows]);

  const tableKeyMap = useMemo(() => (config ?? defaultBomScannerConfig).jsonKeyMap, [config]);

  const existingHeaders = useMemo(() => {
    if (batchHeaderOrder.length > 0) return batchHeaderOrder.slice(0, 32);
    if (selectedRows.length === 0) return [];
    // 以第一行字段顺序为基准（通常就是导入表头顺序），再把后续行出现的新字段追加到末尾。
    const keys: string[] = [];
    const seen = new Set<string>();

    const first = selectedRows[0];
    if (first) {
      for (const k of Object.keys(first)) {
        if (seen.has(k)) continue;
        seen.add(k);
        keys.push(k);
        if (keys.length >= 32) return keys;
      }
    }

    for (let i = 1; i < selectedRows.length; i += 1) {
      const row = selectedRows[i];
      if (!row) continue;
      for (const k of Object.keys(row)) {
        if (seen.has(k)) continue;
        seen.add(k);
        keys.push(k);
        if (keys.length >= 32) return keys;
      }
    }

    return keys;
  }, [batchHeaderOrder, selectedRows]);

  const dataHeaders = useMemo(() => {
    const rk = tableKeyMap.remark ?? [];
    if (!rk.length) return existingHeaders;
    return existingHeaders.filter((h) => !headerMatchesAny(h, rk));
  }, [existingHeaders, tableKeyMap.remark]);

  const remarkHeaderLabel = tableKeyMap.remark?.[0] ?? '备注';

  const handleParsePreview = (rawText: string) => {
    if (!rawText.trim()) {
      setPreviewHeaders([]);
      setPreviewRows([]);
      setPreviewHeaderError('');
      return;
    }
    try {
      const parsed = parsePastedBom(rawText);
      setPreviewHeaders(parsed.headers);
      setPreviewRows(parsed.rows);
      if (config) {
        const headerCheck = validateRequiredHeaders(parsed.headers, config.jsonKeyMap);
        if (!headerCheck.ok) {
          const missingText = headerCheck.missingGroups
            .map((g) => (g === 'downloadUrl' ? 'downloadUrl（下载路径）' : 'expectedMd5（期望MD5）'))
            .join('、');
          setPreviewHeaderError(`列头缺少必需列组：${missingText}。该表将不能入库。`);
        } else {
          setPreviewHeaderError('');
        }
      } else {
        setPreviewHeaderError('');
      }
    } catch {
      setPreviewHeaders([]);
      setPreviewRows([]);
      setPreviewHeaderError('');
    }
  };

  const handleClearImportPreview = () => {
    setPastedText('');
    setPreviewHeaders([]);
    setPreviewRows([]);
    setPreviewHeaderError('');
    const el = pasteAreaRef.current;
    if (el) el.textContent = PASTE_AREA_HINT;
  };

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [scanner, prods, af] = await Promise.all([
        fetchBomScannerSettings(),
        fetchProducts(),
        fetchArtifactorySettings(),
      ]);
      setConfig(scanner);
      setProducts(prods);
      setArtifactoryConfig(af);

      const presetProductId = searchParams.get('productId');
      if (isNew) {
        const pick = presetProductId && prods.some((p) => p.id === presetProductId) ? presetProductId : (prods[0]?.id ?? '');
        if (!selectedProductId) setSelectedProductId(pick);
        setLoadedBomRows([]);
      } else {
        const b = await fetchBomBatchById(batchId);
        if (!b) throw new Error('未找到该批次');
        setBatchName(b.name);
        setSelectedProductId(b.productId);
        setBatchHeaderOrder(b.headerOrder ?? []);

        const rows = await fetchBomRows(batchId);
        setLoadedBomRows(rows);
        setSelectedRows(rows.map((x) => x.bom_row));
        try {
          const jobs = await fetchBomDownloadJobsForBatch(batchId);
          setDownloadJobs(jobs);
        } catch {
          setDownloadJobs([]);
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    downloadJobStatusRef.current = new Map();
    setCopyRowIds(new Set());
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batchId]);

  useEffect(() => {
    if (!batchId || !config || loadedBomRows.length === 0) {
      setLocalInfoByMd5(new Map());
      return;
    }
    const md5s = loadedBomRows
      .map((r) => extractExpectedMd5FromRow(r.bom_row, config.jsonKeyMap))
      .filter((m): m is string => m != null);
    let cancelled = false;
    fetchLocalFileInfoByMd5(md5s)
      .then((m) => {
        if (!cancelled) setLocalInfoByMd5(m);
      })
      .catch(() => {
        if (!cancelled) setLocalInfoByMd5(new Map());
      });
    return () => {
      cancelled = true;
    };
  }, [batchId, config, loadedBomRows]);

  const eligiblePullCount = useMemo(() => {
    if (!config) return 0;
    return loadedBomRows.filter((lr) => rowEligibleForItPull(lr, tableKeyMap, localInfoByMd5)).length;
  }, [loadedBomRows, config, tableKeyMap, localInfoByMd5]);

  const copyableRowIds = useMemo(() => {
    if (!config) return [] as string[];
    return loadedBomRows.filter((lr) => rowHasArtifactoryHttpUrl(lr, tableKeyMap)).map((lr) => lr.id);
  }, [loadedBomRows, config, tableKeyMap]);

  const allCopyableRowsSelected = useMemo(
    () => copyableRowIds.length > 0 && copyableRowIds.every((id) => copyRowIds.has(id)),
    [copyableRowIds, copyRowIds],
  );

  const hasActiveDownloadJob = useMemo(
    () => downloadJobs.some((j) => j.status === 'queued' || j.status === 'running'),
    [downloadJobs],
  );

  const latestDownloadJob = downloadJobs[0] ?? null;
  const queuedDownloadJob = useMemo(
    () => downloadJobs.find((j) => j.status === 'queued') ?? null,
    [downloadJobs],
  );

  useEffect(() => {
    if (!batchId || !hasActiveDownloadJob) return;
    const id = window.setInterval(() => {
      void fetchBomDownloadJobsForBatch(batchId).then(setDownloadJobs);
    }, 1500);
    return () => window.clearInterval(id);
  }, [batchId, hasActiveDownloadJob]);

  useEffect(() => {
    for (const j of downloadJobs) {
      const prev = downloadJobStatusRef.current.get(j.id);
      downloadJobStatusRef.current.set(j.id, j.status);
      if (
        (prev === 'queued' || prev === 'running') &&
        downloadJobIsTerminal(j.status)
      ) {
        void load();
        break;
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅在任务状态从进行中变为终态时刷新批次
  }, [downloadJobs]);

  const handleDownloadAllIt = async () => {
    if (!batchId) return;
    setDownloadBusy('all');
    try {
      await requestBomItDownload(batchId, null);
      const jobs = await fetchBomDownloadJobsForBatch(batchId);
      setDownloadJobs(jobs);
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setDownloadBusy(null);
    }
  };

  const handleDownloadOneIt = async (rowId: string) => {
    if (!batchId) return;
    setDownloadBusy(rowId);
    try {
      await requestBomItDownload(batchId, [rowId]);
      const jobs = await fetchBomDownloadJobsForBatch(batchId);
      setDownloadJobs(jobs);
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setDownloadBusy(null);
    }
  };

  const handleCancelQueuedDownload = async (jobId: string) => {
    if (!batchId) return;
    setDownloadCancelBusy(true);
    try {
      const ok = await cancelBomDownloadJob(jobId);
      if (!ok) {
        alert('无法取消：任务可能已开始执行或已结束。');
      }
      const jobs = await fetchBomDownloadJobsForBatch(batchId);
      setDownloadJobs(jobs);
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setDownloadCancelBusy(false);
    }
  };

  const toggleCopyRowId = (rowId: string) => {
    setCopyRowIds((prev) => {
      const next = new Set(prev);
      if (next.has(rowId)) next.delete(rowId);
      else next.add(rowId);
      return next;
    });
  };

  const toggleSelectAllCopyableRows = () => {
    if (allCopyableRowsSelected) {
      setCopyRowIds(new Set());
    } else {
      setCopyRowIds(new Set(copyableRowIds));
    }
  };

  const handleCopyDownloadCommands = async (tool: 'curl' | 'wget') => {
    if (!config) return;
    const af = artifactoryConfig;
    if (!af) {
      alert('无法读取 Artifactory 配置，请稍后重试或检查系统设置。');
      return;
    }
    if (!(af.artifactoryApiKey || '').trim() && !(af.artifactoryExtApiKey || '').trim()) {
      alert('请先在「系统设置」中配置 Artifactory API Key（主实例或扩展实例）。');
      return;
    }
    const items = loadedBomRows
      .map((lr, idx) => ({ row: lr, displayLine: idx + 1 }))
      .filter(({ row }) => copyRowIds.has(row.id));
    if (items.length === 0) {
      alert('请先勾选表格左侧复选框（需为含 it-Artifactory 链接的行）。');
      return;
    }
    const { text, errors } = buildCopyCommandsForRows(items, config.jsonKeyMap, af, tool);
    if (!text.trim()) {
      alert(errors.length ? errors.join('\n') : '没有可生成的命令。');
      return;
    }
    let clip = text;
    if (errors.length) {
      clip += `\n\n# 以下行已跳过：\n${errors.map((e) => `# ${e}`).join('\n')}`;
    }
    try {
      await navigator.clipboard.writeText(clip);
      const label = tool === 'curl' ? 'curl' : 'wget';
      setCopyCmdToast(`已复制 ${label}（${items.length} 条命令${errors.length ? `，${errors.length} 条跳过` : ''}）`);
      window.setTimeout(() => setCopyCmdToast(null), 4000);
      if (errors.length) {
        alert(`已复制到剪贴板；另有 ${errors.length} 行无法生成（见剪贴板末尾注释）。`);
      }
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    }
  };

  const handleArtifactoryEnrich = async () => {
    if (!batchId || !config) return;
    const af = artifactoryConfig;
    if (!af) {
      alert('无法读取 Artifactory 配置，请稍后重试或检查系统设置。');
      return;
    }
    setArtifactoryEnrichLoading(true);
    try {
      const { rows: enriched, summary } = await enrichBomRowsFromArtifactory(
        loadedBomRows,
        config.jsonKeyMap,
        af,
      );
      const jm = config.jsonKeyMap;
      const toEnsure = [jm.fileSizeBytes?.[0], jm.remark?.[0]].filter(Boolean) as string[];
      const baseHo = batchHeaderOrder.length > 0 ? batchHeaderOrder : existingHeaders;
      const ho = mergeHeaderOrder([...baseHo], toEnsure);
      let persisted = 0;
      for (let i = 0; i < enriched.length; i += 1) {
        const a = loadedBomRows[i];
        const b = enriched[i];
        if (a && b && JSON.stringify(a.bom_row) !== JSON.stringify(b.bom_row)) {
          await updateBomRowRecord(b.id, b.bom_row);
          persisted += 1;
        }
      }
      if (toEnsure.length) await updateBomBatchHeaderOrder(batchId, ho);
      setBatchHeaderOrder(ho);
      await load();
      const parts = [
        `已写入数据库 ${persisted} 行`,
        `含可请求 URL 并参与拉取 ${summary.rowsWithDownloadUrl} 行`,
        `跳过无 http(s) 下载路径 ${summary.skippedNoUrl} 行`,
      ];
      if (summary.failedChunks) parts.push(`部分批次请求异常 ${summary.failedChunks} 次`);
      alert(parts.join('；'));
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setArtifactoryEnrichLoading(false);
    }
  };

  const handleCreateProduct = async () => {
    try {
      const id = await createProduct({ name: newProductName });
      setNewProductName('');
      const prods = await fetchProducts();
      setProducts(prods);
      setSelectedProductId(id);
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    }
  };

  const handleSave = async () => {
    if (!config) return;
    if (!selectedProductId) {
      alert('请选择产品');
      return;
    }
    if (!batchName.trim()) {
      alert('请填写批次名称');
      return;
    }
    if (!pastedText.trim()) {
      alert('请先粘贴 BOM 内容');
      return;
    }

    try {
      const parsed = parsePastedBom(pastedText);
      const headerCheck = validateRequiredHeaders(parsed.headers, config.jsonKeyMap);
      if (!headerCheck.ok) {
        const missingText = headerCheck.missingGroups
          .map((g) => (g === 'downloadUrl' ? 'downloadUrl（下载路径）' : 'expectedMd5（期望MD5）'))
          .join('、');
        alert(`列头校验失败：缺少必需列组 ${missingText}。请确认表头包含 jsonKeyMap 中对应别名。`);
        return;
      }

      setSaveLoading(true);
      if (isNew) {
        const id = await createBatchWithRows({ name: batchName, productId: selectedProductId, headerOrder: parsed.headers, rows: parsed.rows });
        setLastMessage(`已创建批次，共 ${parsed.rows.length} 行；告警 ${buildBomWarnings(parsed.rows, config.jsonKeyMap).length} 条`);
        navigate(`/bom/${id}`, { replace: true });
      } else {
        await updateBomBatchHeaderOrder(batchId, parsed.headers);
        await replaceBatchRows(batchId, parsed.rows);
        setBatchHeaderOrder(parsed.headers);
        setLastMessage(`已覆盖批次，共 ${parsed.rows.length} 行；告警 ${buildBomWarnings(parsed.rows, config.jsonKeyMap).length} 条`);
        const refreshed = await fetchBomRows(batchId);
        setLoadedBomRows(refreshed);
        setSelectedRows(refreshed.map((x) => x.bom_row));
      }
      setPastedText('');
      handleClearImportPreview();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setSaveLoading(false);
    }
  };

  return (
    <div className="max-w-[96rem] mx-auto space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-lg bg-indigo-600 text-white flex items-center justify-center flex-shrink-0">
            <Package size={22} />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => navigate('/bom')}
                className="inline-flex items-center gap-1.5 text-slate-600 hover:text-slate-800 text-sm"
              >
                <ArrowLeft size={16} />
                返回
              </button>
            </div>
            <h2 className="text-2xl font-bold text-slate-900 mt-1">{isNew ? '新建批次' : '编辑批次'}</h2>
            <p className="text-slate-500 mt-1">
              在此页粘贴并入库 BOM。必需列头：下载路径类 + 期望 MD5 类。
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => load()}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50"
          >
            <RefreshCcw size={16} />
            刷新
          </button>
        </div>
      </div>

      {error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      ) : null}

      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6 space-y-4">
        <div className="grid md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">产品（必选）</label>
            <select
              value={selectedProductId}
              onChange={(e) => setSelectedProductId(e.target.value)}
              className="w-full px-4 py-2 border border-gray-200 rounded-lg bg-white"
            >
              <option value="">请选择产品</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">版本（批次名称）</label>
            <input
              type="text"
              value={batchName}
              onChange={(e) => setBatchName(e.target.value)}
              placeholder="例如：4.11 / 2026Q1 / release-xxx"
              className="w-full px-4 py-2 border border-gray-200 rounded-lg"
            />
          </div>
        </div>

        <div className="grid md:grid-cols-2 gap-4">
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
            <p className="font-medium text-slate-700 mb-2">表头示例（`…` 表示其它任意列名；彩色列为必选表头）</p>
            <div className="overflow-x-auto rounded-md border border-slate-200 bg-white">
              <table className="min-w-full border-collapse text-left">
                <thead>
                  <tr>
                    {headerExampleCells.map((cell, idx) => {
                      const isEllipsis = cell === '…';
                      return (
                        <th
                          key={idx}
                          scope="col"
                          className={`px-3 py-2 border-b border-slate-200 whitespace-nowrap ${
                            isEllipsis ? 'text-slate-400 bg-slate-50 font-normal' : 'bg-indigo-50/80 text-indigo-900 font-semibold'
                          } ${idx < headerExampleCells.length - 1 ? 'border-r border-slate-200' : ''}`}
                        >
                          {cell}
                        </th>
                      );
                    })}
                  </tr>
                </thead>
              </table>
            </div>
            <p className="text-slate-500 mt-2">具体列名以系统设置 jsonKeyMap 为准。</p>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">快速新增产品/分类</label>
            <div className="flex gap-2">
              <input
                type="text"
                value={newProductName}
                onChange={(e) => setNewProductName(e.target.value)}
                placeholder="产品名称"
                className="flex-1 px-3 py-2 border border-gray-200 rounded-lg"
              />
              <button
                type="button"
                onClick={handleCreateProduct}
                className="px-3 py-2 rounded-lg bg-slate-800 text-white hover:bg-slate-900 disabled:opacity-50"
                disabled={!newProductName.trim()}
              >
                新增产品
              </button>
            </div>
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">快捷粘贴区（支持 Excel 表格 HTML）</label>
          <div
            ref={pasteAreaRef}
            className="w-full min-h-24 px-3 py-2 border border-dashed border-slate-300 rounded-lg text-xs text-slate-500 bg-slate-50"
            contentEditable
            suppressContentEditableWarning
            onPaste={(e) => {
              e.preventDefault();
              const html = e.clipboardData.getData('text/html');
              const text = e.clipboardData.getData('text/plain');
              try {
                const parsed = parsePastedFromClipboard(html, text);
                const normalizedText = [parsed.headers.join('\t'), ...parsed.rows.map((r) => parsed.headers.map((h) => r[h] ?? '').join('\t'))].join('\n');
                setPastedText(normalizedText);
                setPreviewHeaders(parsed.headers);
                setPreviewRows(parsed.rows);
                if (config) {
                  const headerCheck = validateRequiredHeaders(parsed.headers, config.jsonKeyMap);
                  if (!headerCheck.ok) {
                    const missingText = headerCheck.missingGroups
                      .map((g) => (g === 'downloadUrl' ? 'downloadUrl（下载路径）' : 'expectedMd5（期望MD5）'))
                      .join('、');
                    setPreviewHeaderError(`列头缺少必需列组：${missingText}。该表将不能入库。`);
                  } else {
                    setPreviewHeaderError('');
                  }
                }
              } catch (err) {
                alert(err instanceof Error ? err.message : String(err));
              }
            }}
          >
            {PASTE_AREA_HINT}
          </div>
        </div>

        <div>
          <button
            type="button"
            onClick={() => setShowRawInput((v) => !v)}
            className="text-xs text-indigo-700 hover:text-indigo-800 underline underline-offset-2"
          >
            {showRawInput ? '隐藏高级选项：BOM 原始内容' : '展开高级选项：BOM 原始内容'}
          </button>
        </div>

        {showRawInput ? (
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">BOM 原始内容（高级）</label>
            <textarea
              value={pastedText}
              onChange={(e) => {
                const v = e.target.value;
                setPastedText(v);
                handleParsePreview(v);
              }}
              rows={10}
              spellCheck={false}
              className="w-full px-4 py-3 border border-gray-200 rounded-lg font-mono text-xs"
            />
          </div>
        ) : null}

        <div>
          <div className="flex items-center justify-between gap-3 mb-1">
            <label className="text-sm font-medium text-slate-700 shrink-0">导入预览（全部）</label>
            <button
              type="button"
              onClick={handleClearImportPreview}
              disabled={!pastedText.trim() && previewRows.length === 0}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md border border-slate-300 text-slate-600 hover:bg-slate-100 disabled:opacity-40 disabled:pointer-events-none"
            >
              <Trash2 size={14} className="shrink-0" />
              清空
            </button>
          </div>
          {previewHeaderError ? (
            <div className="mb-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              {previewHeaderError}
            </div>
          ) : null}
          {previewRows.length > 0 ? (
            <div className="overflow-auto border border-gray-200 rounded-lg">
              <table className="min-w-full text-xs table-fixed">
                <thead className="bg-slate-50">
                  <tr>
                    <th className="px-3 py-2 text-left font-semibold text-slate-700 border-b border-gray-200 whitespace-nowrap w-12">
                      行号
                    </th>
                    {previewHeaders.map((h) => {
                      const linkOrMd5 =
                        headerIsDownloadColumn(h, tableKeyMap) || headerIsMd5Column(h, tableKeyMap);
                      return (
                        <th
                          key={h}
                          className={`px-3 py-2 text-left font-semibold text-slate-700 border-b border-gray-200 whitespace-nowrap ${
                            linkOrMd5 ? 'max-w-[14rem] w-[14rem]' : 'max-w-[11rem]'
                          }`}
                        >
                          {h}
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {previewRows.map((r, i) => (
                    <tr key={i} className="border-b last:border-b-0">
                      <td className="px-3 py-2 text-slate-500 whitespace-nowrap w-12 align-middle">{i + 1}</td>
                      {previewHeaders.map((h) => {
                        const linkOrMd5 =
                          headerIsDownloadColumn(h, tableKeyMap) || headerIsMd5Column(h, tableKeyMap);
                        return (
                          <td
                            key={`${i}-${h}`}
                            className={`px-3 py-2 text-slate-700 align-middle ${
                              linkOrMd5 ? 'max-w-[14rem] w-[14rem]' : 'max-w-[11rem]'
                            }`}
                          >
                            <BomDataTableCell header={h} value={r[h] ?? ''} keyMap={tableKeyMap} />
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-xs text-slate-500">尚未解析到可预览内容。</p>
          )}
        </div>

        <div className="flex items-center justify-between">
          <div className="text-sm text-slate-600">
            当前批次行数：{selectedRows.length}，告警：{selectedWarnings.length} 条（不阻断）
          </div>
          <button
            type="button"
            onClick={handleSave}
            disabled={saveLoading}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-60"
          >
            {saveLoading ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
            {isNew ? '创建并入库' : '覆盖并保存'}
          </button>
        </div>

        {lastMessage ? <p className="text-sm text-emerald-700">{lastMessage}</p> : null}
      </div>

      {!isNew ? (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6 space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <h3 className="text-lg font-medium text-slate-800">已入库数据（只读预览 · 校验与获取状态）</h3>
            {loadedBomRows.length > 0 ? (
              <button
                type="button"
                onClick={() => void handleArtifactoryEnrich()}
                disabled={artifactoryEnrichLoading}
                className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-amber-300 bg-amber-50 text-amber-950 text-sm font-medium hover:bg-amber-100 disabled:opacity-60"
              >
                {artifactoryEnrichLoading ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
                从 Artifactory 补充 MD5/大小
              </button>
            ) : null}
          </div>
          <p className="text-xs text-slate-500">
            「本地文件」为与期望 MD5 匹配的 <code className="bg-slate-100 px-1 rounded">local_file.path</code>{' '}
            文件名（悬停可看完整相对路径）。「大小」优先<strong>本地索引</strong>；无本地时显示 Artifactory 写入的<strong>远端</strong>大小；复制按钮复制字节数。
            it-Artifactory 直链由部署侧 <code className="bg-slate-100 px-1 rounded">bom-scanner-worker</code> 使用服务端
            API Key 拉取到暂存目录；其它来源请人工拷贝后扫描。
          </p>
          {loadedBomRows.length > 0 ? (
            <>
              <div className="rounded-lg border border-indigo-100 bg-indigo-50/90 p-4 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="text-sm font-medium text-indigo-950">it-Artifactory 拉取</div>
                    <p className="text-xs text-indigo-900/80 mt-0.5">
                      任务入队后由 <code className="bg-white/80 px-1 rounded text-[11px]">bom-scanner-worker</code>{' '}
                      抢占执行；请保持进程在线、可连 Supabase，并在 worker 的 .env（或 compose）中配置{' '}
                      <code className="bg-white/80 px-1 rounded text-[11px]">IT_ARTIFACTORY_API_KEY</code> 等变量。
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {queuedDownloadJob ? (
                      <button
                        type="button"
                        disabled={downloadCancelBusy}
                        onClick={() => void handleCancelQueuedDownload(queuedDownloadJob.id)}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-slate-700 text-sm font-medium hover:bg-slate-50 disabled:opacity-50"
                      >
                        {downloadCancelBusy ? (
                          <Loader2 size={16} className="animate-spin" />
                        ) : (
                          <XCircle size={16} />
                        )}
                        取消排队
                      </button>
                    ) : null}
                    <button
                      type="button"
                      disabled={eligiblePullCount === 0 || downloadBusy !== null || hasActiveDownloadJob}
                      onClick={() => void handleDownloadAllIt()}
                      className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-indigo-300 bg-white text-indigo-900 text-sm font-medium hover:bg-indigo-100 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {downloadBusy === 'all' ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
                      拉取全部（{eligiblePullCount}）
                    </button>
                    {batchId ? (
                      <button
                        type="button"
                        onClick={() => navigate(`/bom/jobs?batchId=${encodeURIComponent(batchId)}`)}
                        className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-slate-800 text-sm font-medium hover:bg-slate-50"
                      >
                        <HardDriveDownload size={16} />
                        下载任务
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => void handleCopyDownloadCommands('curl')}
                      disabled={copyRowIds.size === 0}
                      title="复制选中行的 curl 命令（含 Authorization 与 X-JFrog-Art-Api）"
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-slate-800 text-sm font-medium hover:bg-slate-50 disabled:opacity-45 disabled:cursor-not-allowed"
                    >
                      <ClipboardCopy size={16} />
                      复制 curl
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleCopyDownloadCommands('wget')}
                      disabled={copyRowIds.size === 0}
                      title="复制选中行的 wget 命令"
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-slate-800 text-sm font-medium hover:bg-slate-50 disabled:opacity-45 disabled:cursor-not-allowed"
                    >
                      <ClipboardCopy size={16} />
                      复制 wget
                    </button>
                  </div>
                </div>
                {copyCmdToast ? (
                  <p className="text-xs text-emerald-800 font-medium px-0.5">{copyCmdToast}</p>
                ) : null}
                <p className="text-[11px] text-slate-600 leading-snug">
                  在下方表格勾选行后，可复制带 API Key 的终端下载命令（与 worker 相同 Bearer，并附带 JFrog 头以便排错）。命令含敏感信息，请勿泄露剪贴板内容。
                </p>
                <p className="text-xs text-amber-950/90 bg-amber-50 border border-amber-200/80 rounded-md px-2.5 py-2 leading-snug">
                  若<strong>长时间停在「排队中」</strong>：多半是 worker 未启动、连不上数据库，或尚未应用含{' '}
                  <code className="font-mono text-[11px]">bom_download_jobs</code> 的迁移。请确认容器/进程在跑并已执行{' '}
                  <code className="font-mono text-[11px]">supabase db reset</code> / migration up。当前版本 worker
                  在两次扫描之间的休眠里也会每隔数秒尝试抢占队列。「取消排队」仅对尚未被 worker
                  接走的任务有效；已进入「拉取中」后无法从网页中止。
                </p>
                {latestDownloadJob ? (
                  <div className="rounded-md border border-indigo-200/80 bg-white/90 px-3 py-2.5 space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-indigo-950">
                      <span className="font-medium">
                        {BOM_DOWNLOAD_JOB_STATUS_LABEL[latestDownloadJob.status]}
                      </span>
                      <span className="font-mono text-indigo-800/90">
                        {latestDownloadJob.progressTotal > 0
                          ? `${latestDownloadJob.progressCurrent}/${latestDownloadJob.progressTotal}`
                          : '—'}
                      </span>
                    </div>
                    {formatDownloadJobBytesLine(latestDownloadJob) ? (
                      <p className="text-[11px] text-indigo-800/90">{formatDownloadJobBytesLine(latestDownloadJob)}</p>
                    ) : null}
                    <div className="h-2 w-full rounded-full bg-indigo-100 overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all duration-300 ${
                          latestDownloadJob.status === 'cancelled' ? 'bg-slate-400' : 'bg-indigo-600'
                        }`}
                        style={{
                          width: `${downloadJobProgressPercent(latestDownloadJob)}%`,
                        }}
                      />
                    </div>
                    {latestDownloadJob.lastMessage ? (
                      <p className="text-[11px] text-indigo-900/90 font-mono break-all leading-snug">
                        {latestDownloadJob.lastMessage}
                      </p>
                    ) : null}
                    {latestDownloadJob.finishedAt ? (
                      <p className="text-[11px] text-slate-500">
                        结束时间：{new Date(latestDownloadJob.finishedAt).toLocaleString()}
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </div>
              <div className="overflow-auto border border-gray-200 rounded-lg">
                <table className="min-w-full text-xs table-fixed">
                  <thead className="bg-slate-50">
                    <tr>
                      <th className="px-3 py-2 text-left font-semibold text-slate-700 border-b border-gray-200 whitespace-nowrap w-12">
                        行号
                      </th>
                      <th className="px-2 py-2 text-center font-semibold text-slate-700 border-b border-gray-200 whitespace-nowrap w-9">
                        <input
                          type="checkbox"
                          checked={allCopyableRowsSelected}
                          disabled={copyableRowIds.length === 0}
                          onChange={toggleSelectAllCopyableRows}
                          title="全选含 it-Artifactory 链接的行（用于复制 curl/wget）"
                          className="h-3.5 w-3.5 rounded border-slate-400 align-middle cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                        />
                      </th>
                      <th className="px-3 py-2 text-center font-semibold text-slate-700 border-b border-gray-200 whitespace-nowrap w-14">
                        拉取
                      </th>
                      <th className="px-3 py-2 text-left font-semibold text-slate-700 border-b border-gray-200 whitespace-nowrap w-[8.5rem]">
                        状态
                      </th>
                      <th className="px-3 py-2 text-left font-semibold text-slate-700 border-b border-gray-200 whitespace-nowrap min-w-[10rem] max-w-[14rem] w-[12rem]">
                        获取说明
                      </th>
                      <th className="px-3 py-2 text-left font-semibold text-slate-700 border-b border-gray-200 whitespace-nowrap w-[12rem] max-w-[12rem]">
                        本地文件
                      </th>
                      <th className="px-3 py-2 text-left font-semibold text-slate-700 border-b border-gray-200 whitespace-nowrap w-[11rem]">
                        大小
                      </th>
                      <th className="px-3 py-2 text-left font-semibold text-slate-700 border-b border-gray-200 min-w-[8rem] max-w-[14rem]">
                        {remarkHeaderLabel}
                      </th>
                      {dataHeaders.map((h) => {
                        const linkOrMd5 =
                          headerIsDownloadColumn(h, tableKeyMap) || headerIsMd5Column(h, tableKeyMap);
                        return (
                          <th
                            key={h}
                            className={`px-3 py-2 text-left font-semibold text-slate-700 border-b border-gray-200 whitespace-nowrap ${
                              linkOrMd5 ? 'max-w-[14rem] w-[14rem]' : 'max-w-[11rem]'
                            }`}
                          >
                            {h}
                          </th>
                        );
                      })}
                    </tr>
                  </thead>
                  <tbody>
                    {loadedBomRows.map((lr, i) => {
                      const r = lr.bom_row;
                      const md5 = extractExpectedMd5FromRow(r, tableKeyMap);
                      const localInfo = md5 != null ? localInfoByMd5.get(md5) : undefined;
                      const localB = localInfo?.sizeBytes ?? null;
                      const localPath = localInfo?.path ?? null;
                      const remoteB = extractRemoteSizeBytesFromRow(r, tableKeyMap);
                      const remarkText = extractRemarkFromRow(r, tableKeyMap);
                      const badgeClass =
                        lr.status === 'verified_ok'
                          ? 'bg-emerald-50 text-emerald-900 border-emerald-200'
                          : lr.status === 'verified_fail'
                            ? 'bg-red-50 text-red-800 border-red-200'
                            : lr.status === 'await_manual_download'
                              ? 'bg-amber-50 text-amber-900 border-amber-200'
                              : lr.status === 'error'
                                ? 'bg-rose-50 text-rose-900 border-rose-200'
                                : 'bg-slate-100 text-slate-800 border-slate-200';
                      const canPullThis = rowEligibleForItPull(lr, tableKeyMap, localInfoByMd5);
                      const canCopyCmd = rowHasArtifactoryHttpUrl(lr, tableKeyMap);
                      return (
                        <tr key={lr.id} className="border-b last:border-b-0">
                          <td className="px-3 py-2 text-slate-500 whitespace-nowrap align-middle w-12">{i + 1}</td>
                          <td className="px-2 py-2 align-middle w-9 text-center">
                            <input
                              type="checkbox"
                              checked={copyRowIds.has(lr.id)}
                              disabled={!canCopyCmd}
                              onChange={() => toggleCopyRowId(lr.id)}
                              title={canCopyCmd ? '勾选后可批量复制 curl/wget' : '无 it-Artifactory 链接'}
                              className="h-3.5 w-3.5 rounded border-slate-400 align-middle cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                            />
                          </td>
                          <td className="px-3 py-2 align-middle w-14 text-center">
                            {canPullThis ? (
                              <button
                                type="button"
                                disabled={downloadBusy !== null || hasActiveDownloadJob}
                                onClick={() => void handleDownloadOneIt(lr.id)}
                                title="拉取本行 it-Artifactory 制品"
                                className="inline-flex items-center justify-center p-1 rounded-md border border-indigo-200 bg-indigo-50 text-indigo-800 hover:bg-indigo-100 disabled:opacity-45 disabled:cursor-not-allowed"
                              >
                                {downloadBusy === lr.id ? (
                                  <Loader2 size={14} className="animate-spin" />
                                ) : (
                                  <Download size={14} />
                                )}
                              </button>
                            ) : (
                              <span className="text-slate-300">—</span>
                            )}
                          </td>
                          <td className="px-3 py-2 whitespace-nowrap align-middle w-[8.5rem]">
                            <span
                              className={`inline-flex rounded-md border px-2 py-0.5 font-medium ${badgeClass}`}
                            >
                              {BOM_ROW_STATUS_LABEL[lr.status]}
                            </span>
                          </td>
                          <td
                            className="px-3 py-2 align-middle min-w-[10rem] max-w-[14rem] w-[12rem] text-slate-700"
                            title={lr.lastFetchError ?? undefined}
                          >
                            {lr.lastFetchError ? (
                              <span className="line-clamp-3 text-left text-[11px] leading-snug">{lr.lastFetchError}</span>
                            ) : lr.status === 'await_manual_download' ? (
                              <span className="text-[11px] text-amber-900/90 leading-snug">请自行下载并放入暂存目录</span>
                            ) : (
                              <span className="text-slate-400">—</span>
                            )}
                          </td>
                          <td className="px-3 py-2 align-middle w-[12rem] max-w-[12rem]">
                            {localPath ? (
                              <span
                                className="block truncate font-mono text-[11px] text-slate-800"
                                title={localPath}
                              >
                                {fileBasename(localPath)}
                              </span>
                            ) : (
                              <span className="text-slate-400">—</span>
                            )}
                          </td>
                          <td className="px-3 py-2 align-middle w-[11rem] max-w-[11rem]">
                            <BomRowByteSizeCell localBytes={localB} remoteBytes={remoteB} />
                          </td>
                          <td
                            className="px-3 py-2 align-middle text-slate-700 min-w-[8rem] max-w-[14rem] overflow-hidden"
                            title={remarkText ?? undefined}
                          >
                            <span className="line-clamp-2 text-left">{remarkText ?? '—'}</span>
                          </td>
                          {dataHeaders.map((h) => {
                            const linkOrMd5 =
                              headerIsDownloadColumn(h, tableKeyMap) || headerIsMd5Column(h, tableKeyMap);
                            return (
                              <td
                                key={`${lr.id}-${h}`}
                                className={`px-3 py-2 text-slate-700 align-middle ${linkOrMd5 ? 'max-w-[14rem] w-[14rem]' : 'max-w-[11rem]'}`}
                              >
                                <BomDataTableCell header={h} value={r[h] ?? ''} keyMap={tableKeyMap} />
                              </td>
                            );
                          })}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="mt-3 space-y-3 text-xs">
                {loadedBomRows.some((lr) =>
                  ['pending', 'verified_ok', 'await_manual_download', 'error'].includes(lr.status),
                ) ? (
                  <div className="rounded-lg border border-slate-100 bg-slate-50/90 px-3 py-2.5 space-y-2 text-slate-600">
                    <div className="font-medium text-slate-800">状态说明</div>
                    {loadedBomRows.some((lr) => lr.status === 'pending') ? (
                      <p className="leading-snug">
                        <span className="font-medium text-slate-700">待处理</span>：{BOM_STATUS_LEGEND_PENDING}
                      </p>
                    ) : null}
                    {loadedBomRows.some((lr) => lr.status === 'verified_ok') ? (
                      <p className="leading-snug">
                        <span className="font-medium text-slate-700">校验通过</span>：{BOM_STATUS_LEGEND_VERIFIED_OK}
                      </p>
                    ) : null}
                    {loadedBomRows.some((lr) => lr.status === 'await_manual_download') ? (
                      <p className="leading-snug">
                        <span className="font-medium text-slate-700">待人工下载</span>：{BOM_STATUS_LEGEND_MANUAL}
                      </p>
                    ) : null}
                    {loadedBomRows.some((lr) => lr.status === 'error') ? (
                      <p className="leading-snug">
                        <span className="font-medium text-slate-700">异常</span>：{BOM_STATUS_LEGEND_ERROR}
                      </p>
                    ) : null}
                  </div>
                ) : null}
                <p className="text-slate-500">
                  状态在每次<strong>扫描任务成功结束</strong>后由服务端按期望 MD5 与{' '}
                  <code className="bg-slate-100 px-1 rounded">local_file</code> 索引刷新；点此页「刷新」可拉取最新状态。
                </p>
              </div>
            </>
          ) : (
            <p className="text-sm text-slate-500">该批次暂无已入库行数据。</p>
          )}
          {existingHeaders.length >= 32 ? (
            <p className="text-xs text-slate-500">列数过多时仅展示前 32 列。</p>
          ) : null}
        </div>
      ) : null}

      {!isNew ? (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6 space-y-3">
          <h3 className="text-lg font-medium text-slate-800">告警（宽松校验）</h3>
          {selectedWarnings.length > 0 ? (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
              <div className="flex items-center gap-2 text-amber-800 mb-2">
                <AlertTriangle size={16} />
                <span className="text-sm font-medium">最多显示 50 条</span>
              </div>
              <ul className="text-sm text-amber-900 space-y-1">
                {selectedWarnings.slice(0, 50).map((w, idx) => (
                  <li key={`${w.rowIndex}-${idx}`}>第 {w.rowIndex} 行：{w.message}</li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="text-sm text-slate-500">暂无告警。</p>
          )}
        </div>
      ) : null}

      {loading ? (
        <div className="text-sm text-slate-500">加载中…</div>
      ) : null}
    </div>
  );
};

