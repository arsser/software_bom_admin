import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, Loader2, Package, RefreshCcw, Save, Trash2 } from 'lucide-react';
import { defaultBomScannerConfig, fetchBomScannerSettings, type BomScannerConfig } from '../lib/bomScannerSettings';
import {
  buildBomWarnings,
  createBatchWithRows,
  fetchBomBatchById,
  fetchBomRows,
  parsePastedBom,
  parsePastedFromClipboard,
  replaceBatchRows,
  updateBomBatchHeaderOrder,
  validateRequiredHeaders,
  type BomRowRecord,
} from '../lib/bomBatches';
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
  const [batchHeaderOrder, setBatchHeaderOrder] = useState<string[]>([]);
  const [lastMessage, setLastMessage] = useState<string>('');

  const [previewRows, setPreviewRows] = useState<BomRowRecord[]>([]);
  const [previewHeaders, setPreviewHeaders] = useState<string[]>([]);
  const [showRawInput, setShowRawInput] = useState(false);
  const [previewHeaderError, setPreviewHeaderError] = useState<string>('');

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
      const [scanner, prods] = await Promise.all([
        fetchBomScannerSettings(),
        fetchProducts(),
      ]);
      setConfig(scanner);
      setProducts(prods);

      const presetProductId = searchParams.get('productId');
      if (isNew) {
        const pick = presetProductId && prods.some((p) => p.id === presetProductId) ? presetProductId : (prods[0]?.id ?? '');
        if (!selectedProductId) setSelectedProductId(pick);
      } else {
        const b = await fetchBomBatchById(batchId);
        if (!b) throw new Error('未找到该批次');
        setBatchName(b.name);
        setSelectedProductId(b.productId);
        setBatchHeaderOrder(b.headerOrder ?? []);

        const rows = await fetchBomRows(batchId);
        const r = rows.map((x) => x.bom_row);
        setSelectedRows(r);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batchId]);

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
        setSelectedRows(parsed.rows);
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
    <div className="max-w-5xl mx-auto space-y-6">
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
              <table className="min-w-full text-xs">
                <thead className="bg-slate-50">
                  <tr>
                    <th className="px-3 py-2 text-left font-semibold text-slate-700 border-b border-gray-200 whitespace-nowrap">行号</th>
                    {previewHeaders.map((h) => (
                      <th key={h} className="px-3 py-2 text-left font-semibold text-slate-700 border-b border-gray-200 whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {previewRows.map((r, i) => (
                    <tr key={i} className="border-b last:border-b-0">
                      <td className="px-3 py-2 text-slate-500 whitespace-nowrap">{i + 1}</td>
                      {previewHeaders.map((h) => (
                        <td key={`${i}-${h}`} className="px-3 py-2 text-slate-700 whitespace-nowrap max-w-56 overflow-hidden text-ellipsis">{r[h] ?? ''}</td>
                      ))}
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
          <h3 className="text-lg font-medium text-slate-800">已入库数据（只读预览）</h3>
          {selectedRows.length > 0 ? (
            <div className="overflow-auto border border-gray-200 rounded-lg">
              <table className="min-w-full text-xs">
                <thead className="bg-slate-50">
                  <tr>
                    <th className="px-3 py-2 text-left font-semibold text-slate-700 border-b border-gray-200 whitespace-nowrap">行号</th>
                    {existingHeaders.map((h) => (
                      <th key={h} className="px-3 py-2 text-left font-semibold text-slate-700 border-b border-gray-200 whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {selectedRows.map((r, i) => (
                    <tr key={i} className="border-b last:border-b-0">
                      <td className="px-3 py-2 text-slate-500 whitespace-nowrap">{i + 1}</td>
                      {existingHeaders.map((h) => (
                        <td key={`${i}-${h}`} className="px-3 py-2 text-slate-700 whitespace-nowrap max-w-56 overflow-hidden text-ellipsis">{r[h] ?? ''}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
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

