import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft,
  Download,
  FolderSearch,
  Loader2,
  Package,
  RefreshCcw,
  UploadCloud,
} from 'lucide-react';
import { defaultBomScannerConfig, fetchBomScannerSettings, type BomScannerConfig } from '../lib/bomScannerSettings';
import {
  fetchBomBatchById,
  fetchBomRows,
  fetchLocalFileInfoByMd5,
  refreshBomRowStatusesForBatch,
  type BomBatchRow,
  type LocalFileIndexInfo,
} from '../lib/bomBatches';
import {
  extractExpectedMd5FromRow,
  extractExtUrlFromRow,
  extractExtSizeBytesFromRow,
  extractRemoteSizeBytesFromRow,
  normalizeLocalRelativePath,
  headerMatchesAny,
  remarkColumnKeys,
  deriveLocalExtStatusLabels,
  rowExtUiComplete,
} from '../lib/bomRowFields';
import { BOM_ROW_FEISHU_STATUS_LABEL, formatBomRowStatusTooltip } from '../lib/bomRowStatus';
import { requestBomFeishuScan } from '../lib/bomFeishuScan';
import { BomRowByteSizeCell } from './HumanByteSize';
import { BomDataTableCell, headerIsDownloadColumn, headerIsMd5Column } from '../lib/bomTableCell';

/** BOM 分发页：只读表格 + 本地/外部状态查看；拉取（外部 AF）与飞书上传为占位，不展示内部仓库操作 */
export const BomDistributePage: React.FC = () => {
  const navigate = useNavigate();
  const params = useParams();
  const batchId = params.batchId ?? null;

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [batchName, setBatchName] = useState('');
  const [productName, setProductName] = useState('');
  const [batchHeaderOrder, setBatchHeaderOrder] = useState<string[]>([]);
  const [config, setConfig] = useState<BomScannerConfig | null>(null);
  const [loadedBomRows, setLoadedBomRows] = useState<BomBatchRow[]>([]);
  const [localInfoByMd5, setLocalInfoByMd5] = useState<Map<string, LocalFileIndexInfo>>(() => new Map());
  const [localIndexReady, setLocalIndexReady] = useState(true);
  const [filterStoredLocalNotVerifiedOk, setFilterStoredLocalNotVerifiedOk] = useState(false);
  const [filterStoredExtNotComplete, setFilterStoredExtNotComplete] = useState(false);
  const [feishuScanBusy, setFeishuScanBusy] = useState(false);

  const tableKeyMap = useMemo(() => (config ?? defaultBomScannerConfig).jsonKeyMap, [config]);
  const selectedRows = useMemo(() => loadedBomRows.map((x) => x.bom_row), [loadedBomRows]);

  const existingHeaders = useMemo(() => {
    if (batchHeaderOrder.length > 0) return batchHeaderOrder.slice(0, 32);
    if (selectedRows.length === 0) return [];
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
    const sizeKeys = tableKeyMap.fileSizeBytes ?? [];
    const extSizeKeys = tableKeyMap.extFileSizeBytes ?? [];
    const extUrlKeys = tableKeyMap.extUrl ?? [];
    return existingHeaders.filter((h) => {
      if (sizeKeys.length && headerMatchesAny(h, sizeKeys)) return false;
      if (extSizeKeys.length && headerMatchesAny(h, extSizeKeys)) return false;
      if (extUrlKeys.length && headerMatchesAny(h, extUrlKeys)) return false;
      return true;
    });
  }, [existingHeaders, tableKeyMap]);

  const remarkHeaderKeys = useMemo(() => remarkColumnKeys(tableKeyMap), [tableKeyMap]);

  const filteredStoredBomRows = useMemo(() => {
    return loadedBomRows.filter((lr) => {
      if (filterStoredLocalNotVerifiedOk && lr.status.local === 'verified_ok') return false;
      if (filterStoredExtNotComplete && rowExtUiComplete(lr, tableKeyMap)) return false;
      return true;
    });
  }, [loadedBomRows, filterStoredLocalNotVerifiedOk, filterStoredExtNotComplete, tableKeyMap]);

  /** 占位：尚未本地校验通过的行数（用于「全部拉取」提示） */
  const eligibleExternalPullStubCount = useMemo(
    () => loadedBomRows.filter((lr) => lr.status.local !== 'verified_ok').length,
    [loadedBomRows],
  );
  /** 占位：已有本地校验通过、可视为「待上传飞书」的行数 */
  const eligibleFeishuStubCount = useMemo(
    () => loadedBomRows.filter((lr) => lr.status.local === 'verified_ok').length,
    [loadedBomRows],
  );

  const load = async () => {
    if (!batchId) return;
    setLoading(true);
    setError(null);
    try {
      const scanner = await fetchBomScannerSettings();
      setConfig(scanner);

      const b = await fetchBomBatchById(batchId);
      if (!b) throw new Error('未找到该版本');
      setBatchName(b.name);
      setProductName(b.productName ?? '');
      setBatchHeaderOrder(b.headerOrder ?? []);

      try {
        await refreshBomRowStatusesForBatch(batchId);
      } catch (e) {
        console.warn('WARN refreshBomRowStatusesForBatch', e instanceof Error ? e.message : String(e));
      }

      const rows = await fetchBomRows(batchId);
      setLoadedBomRows(rows);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!batchId || batchId === 'new') {
      setError('无效版本');
      setLoading(false);
      return;
    }
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batchId]);

  useEffect(() => {
    if (!batchId || !config || loadedBomRows.length === 0) {
      setLocalInfoByMd5(new Map());
      setLocalIndexReady(true);
      return;
    }
    const md5s = loadedBomRows
      .map((r) => extractExpectedMd5FromRow(r.bom_row, config.jsonKeyMap))
      .filter((m): m is string => m != null);
    if (md5s.length === 0) {
      setLocalInfoByMd5(new Map());
      setLocalIndexReady(true);
      return;
    }
    setLocalIndexReady(false);
    let cancelled = false;
    fetchLocalFileInfoByMd5(md5s)
      .then((m) => {
        if (!cancelled) {
          setLocalInfoByMd5(m);
          setLocalIndexReady(true);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLocalInfoByMd5(new Map());
          setLocalIndexReady(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [batchId, config, loadedBomRows]);

  const stubExternalPullAll = () => {
    alert(
      `从外部 Artifactory 拉取至本地暂存：接口开发中（当前共 ${loadedBomRows.length} 行）。`,
    );
  };

  const stubExternalPullRow = () => {
    alert('从外部 Artifactory 拉取本行：接口开发中。');
  };

  const stubFeishuUploadAll = () => {
    alert(
      `上传到飞书网盘：接口开发中（当前约 ${eligibleFeishuStubCount} 行已本地校验通过）。\n` +
        '将支持分片上传、去重与 MD5 校验等。',
    );
  };

  const stubFeishuUploadRow = () => {
    alert('上传到飞书网盘：接口开发中。');
  };

  const handleFeishuScan = async () => {
    if (!batchId) return;
    setFeishuScanBusy(true);
    try {
      const r = await requestBomFeishuScan(batchId);
      if (!r.ok) {
        alert(r.error);
        return;
      }
      alert(r.message ?? `扫描完成：存在 ${r.rows_present}，缺失 ${r.rows_absent}，错误 ${r.rows_error}`);
      await load();
    } finally {
      setFeishuScanBusy(false);
    }
  };

  if (!batchId || batchId === 'new') {
    return (
      <div className="max-w-5xl mx-auto p-6 text-slate-600">
        <p>无效版本。</p>
        <button type="button" className="mt-4 text-indigo-700" onClick={() => navigate('/bom')}>
          返回 BOM 管理
        </button>
      </div>
    );
  }

  return (
    <div className="max-w-[96rem] mx-auto space-y-5 pb-2">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3 min-w-0 flex-1">
          <div className="w-10 h-10 rounded-lg bg-indigo-600 text-white flex items-center justify-center flex-shrink-0">
            <Package size={22} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => navigate('/bom')}
                className="inline-flex items-center gap-1.5 text-slate-600 hover:text-slate-800 text-sm"
              >
                <ArrowLeft size={16} />
                BOM 管理
              </button>
              <span className="text-slate-300">|</span>
              <button
                type="button"
                onClick={() => navigate(`/bom/${batchId}`)}
                className="text-sm text-indigo-700 hover:text-indigo-800"
              >
                查看/编辑此版本
              </button>
            </div>
            <h2 className="text-2xl font-bold text-slate-900 mt-1">BOM 分发</h2>
            <p className="text-slate-500 mt-1 text-sm">
              只读查看已入库清单与状态；「拉取」对应外部 Artifactory，「上传」对应飞书网盘（能力接入前为占位）。
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => load()}
          className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50 shrink-0"
        >
          <RefreshCcw size={16} />
          刷新
        </button>
      </div>

      <div className="rounded-xl border border-indigo-200 bg-gradient-to-r from-indigo-50 via-white to-slate-50 px-5 py-4 shadow-sm">
        <div className="flex flex-wrap gap-x-10 gap-y-4 items-start">
          <div className="min-w-0">
            <div className="text-xs font-semibold text-indigo-700 tracking-wide uppercase">产品</div>
            <div className="mt-1 text-2xl font-bold text-slate-900 truncate" title={productName || undefined}>
              {loading && !productName ? '…' : productName || '—'}
            </div>
          </div>
          <div className="hidden sm:block w-px self-stretch min-h-[3rem] bg-indigo-100" aria-hidden />
          <div className="min-w-0 flex-1 sm:flex-initial">
            <div className="text-xs font-semibold text-indigo-700 tracking-wide uppercase">版本</div>
            <div className="mt-1 text-2xl font-bold text-slate-900 truncate" title={batchName || undefined}>
              {loading && !batchName ? '…' : batchName || '—'}
            </div>
          </div>
        </div>
      </div>

      {error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      ) : null}

      <div className="grid md:grid-cols-2 gap-4">
        <div className="rounded-lg border border-sky-200 bg-sky-50/90 p-3 md:p-4 space-y-2">
          <div className="text-sm font-medium text-sky-950">外部 Artifactory · 拉取至本地</div>
          <p className="text-xs text-sky-900/90">
            从 BOM 中的外部下载地址拉取制品到系统暂存（与编辑页「拉取」列语义对应，对接开发中）。
          </p>
          <button
            type="button"
            disabled={loadedBomRows.length === 0}
            onClick={() => stubExternalPullAll()}
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-sky-300 bg-white text-sky-950 text-sm font-medium hover:bg-sky-100 disabled:opacity-50"
          >
            <Download size={16} />
            全部拉取（约 {eligibleExternalPullStubCount} 行待就绪）
          </button>
        </div>

        <div className="rounded-lg border border-violet-200 bg-violet-50/90 p-3 md:p-4 space-y-2">
          <div className="text-sm font-medium text-violet-950">飞书网盘 · 扫描 / 上传</div>
          <p className="text-xs text-violet-900/90">
            扫描：在配置的父文件夹下按与外部 AF 一致的相对路径（版本名/分组/文件名）对账，回写每行飞书状态（不经 worker、不计算 MD5）。上传仍由 worker 接入。
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={
                !batchId ||
                loadedBomRows.length === 0 ||
                feishuScanBusy ||
                !(config?.feishuDriveRootFolderToken ?? '').trim()
              }
              onClick={() => void handleFeishuScan()}
              className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-violet-300 bg-white text-violet-950 text-sm font-medium hover:bg-violet-100 disabled:opacity-50"
            >
              {feishuScanBusy ? <Loader2 size={16} className="animate-spin" /> : <FolderSearch size={16} />}
              扫描飞书云盘
            </button>
            <button
              type="button"
              disabled={eligibleFeishuStubCount === 0}
              onClick={() => stubFeishuUploadAll()}
              className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-violet-300 bg-white text-violet-950 text-sm font-medium hover:bg-violet-100 disabled:opacity-50"
            >
              <UploadCloud size={16} />
              全部上传飞书（{eligibleFeishuStubCount}）
            </button>
          </div>
          {!(config?.feishuDriveRootFolderToken ?? '').trim() ? (
            <p className="text-xs text-amber-900">
              请先在系统设置 →「BOM 本地扫描」中配置飞书云盘根目录 folder_token。
            </p>
          ) : null}
        </div>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 md:p-6 space-y-4">
        <h3 className="text-lg font-medium text-slate-800">已入库数据</h3>
        <p className="text-sm text-slate-500 -mt-2">与编辑页相同的表格布局；此处不可修改 BOM 列内容。</p>

        {loadedBomRows.length > 0 ? (
          <>
            <div className="flex flex-col gap-1.5 items-start text-sm text-slate-700">
              <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-5 sm:gap-y-2">
                <label className="inline-flex items-center gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={filterStoredLocalNotVerifiedOk}
                    onChange={(e) => setFilterStoredLocalNotVerifiedOk(e.target.checked)}
                    className="h-3.5 w-3.5 rounded border-slate-400 text-indigo-600 focus:ring-indigo-500"
                  />
                  <span title="隐藏本地状态为「校验通过」的行">只看本地校验未通过</span>
                </label>
                <label className="inline-flex items-center gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={filterStoredExtNotComplete}
                    onChange={(e) => setFilterStoredExtNotComplete(e.target.checked)}
                    className="h-3.5 w-3.5 rounded border-slate-400 text-indigo-600 focus:ring-indigo-500"
                  />
                  <span title="隐藏外部转存链接已就绪的行（与编辑页「ext 已完成」判定一致）">
                    只看外部链接 / ext 未完成
                  </span>
                </label>
              </div>
              {(filterStoredLocalNotVerifiedOk || filterStoredExtNotComplete) ? (
                <span className="text-xs text-slate-500">
                  列表显示 {filteredStoredBomRows.length} / {loadedBomRows.length} 行
                </span>
              ) : null}
            </div>

            {filteredStoredBomRows.length === 0 ? (
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                当前筛选条件下没有匹配行，请取消勾选筛选或调整条件后查看。
              </div>
            ) : (
              <div className="overflow-x-auto border border-gray-200 rounded-lg -mx-0.5">
                <table className="min-w-full text-xs table-fixed">
                  <thead className="bg-slate-50">
                    <tr>
                      <th className="px-3 py-2 text-left font-semibold text-slate-700 border-b border-gray-200 whitespace-nowrap w-12">
                        行号
                      </th>
                      <th className="px-3 py-2 text-center font-semibold text-slate-700 border-b border-gray-200 whitespace-nowrap w-14">
                        拉取
                      </th>
                      <th className="px-3 py-2 text-center font-semibold text-slate-700 border-b border-gray-200 whitespace-nowrap w-14">
                        上传
                      </th>
                      <th
                        className="px-3 py-2 text-left font-semibold text-slate-700 border-b border-gray-200 whitespace-nowrap min-w-[9.5rem] max-w-[11rem] w-[10rem]"
                        title="ext、本地、飞书（扫描写入）"
                      >
                        状态
                      </th>
                      <th
                        className="px-3 py-2 text-left font-semibold text-slate-700 border-b border-gray-200 whitespace-nowrap min-w-[10rem] max-w-[14rem] w-[12rem]"
                        title="与「状态」列对应：ext、本地、飞书说明。"
                      >
                        状态说明
                      </th>
                      <th
                        className="px-3 py-2 text-left font-semibold text-slate-700 border-b border-gray-200 whitespace-nowrap min-w-[10rem] max-w-[14rem] w-[12rem]"
                        title="jsonb 中 ext_url 等别名对应的可下载 URI"
                      >
                        外部 Artifactory 下载链接
                      </th>
                      <th
                        className="px-3 py-2 text-left font-semibold text-slate-700 border-b border-gray-200 min-w-[14rem] max-w-[28rem] w-[18rem]"
                        title="相对暂存根的路径（子目录/文件名），来自 local_file.path"
                      >
                        本地文件
                      </th>
                      <th className="px-3 py-2 text-left font-semibold text-slate-700 border-b border-gray-200 whitespace-nowrap w-[11rem]">
                        大小
                      </th>
                      {dataHeaders.map((h) => {
                        const linkOrMd5 =
                          headerIsDownloadColumn(h, tableKeyMap) || headerIsMd5Column(h, tableKeyMap);
                        const isRemark = headerMatchesAny(h, remarkHeaderKeys);
                        return (
                          <th
                            key={h}
                            title={
                              isRemark
                                ? '导入 BOM 中的原始列，列顺序与粘贴表一致；仅展示，系统不会自动改写'
                                : undefined
                            }
                            className={`px-3 py-2 text-left font-semibold text-slate-700 border-b border-gray-200 whitespace-nowrap ${
                              linkOrMd5 ? 'max-w-[14rem] w-[14rem]' : isRemark ? 'min-w-[8rem] max-w-[14rem]' : 'max-w-[11rem]'
                            }`}
                          >
                            {h}
                          </th>
                        );
                      })}
                    </tr>
                  </thead>
                  <tbody>
                    {filteredStoredBomRows.map((lr, i) => {
                      const r = lr.bom_row;
                      const md5 = extractExpectedMd5FromRow(r, tableKeyMap);
                      const localInfo = md5 != null ? localInfoByMd5.get(md5) : undefined;
                      const localB = localInfo?.sizeBytes ?? null;
                      const localPath = localInfo?.path ?? null;
                      const extB = extractExtSizeBytesFromRow(r, tableKeyMap);
                      const remoteB = extractRemoteSizeBytesFromRow(r, tableKeyMap);
                      const badgeClass =
                        lr.status.ext === 'synced_or_skipped'
                          ? 'bg-emerald-50 text-emerald-900 border-emerald-200'
                          : lr.status.ext === 'error'
                            ? 'bg-rose-50 text-rose-900 border-rose-200'
                            : lr.status.local === 'error'
                              ? 'bg-rose-50 text-rose-900 border-rose-200'
                              : lr.status.local === 'verified_ok'
                                ? 'bg-emerald-50 text-emerald-900 border-emerald-200'
                                : lr.status.local === 'verified_fail'
                                  ? 'bg-red-50 text-red-800 border-red-200'
                                  : lr.status.local === 'await_manual_download'
                                    ? 'bg-amber-50 text-amber-900 border-amber-200'
                                    : 'bg-slate-100 text-slate-800 border-slate-200';
                      const indexedMd5Hit =
                        md5 != null && localIndexReady ? localInfoByMd5.has(md5) : null;
                      const { localLabel, extLabel } = deriveLocalExtStatusLabels(
                        lr,
                        tableKeyMap,
                        indexedMd5Hit,
                      );
                      const extUrlCell = extractExtUrlFromRow(r, tableKeyMap);
                      const localExplainRaw = lr.status.local_fetch_error?.trim() ?? null;
                      const extExplainRaw = lr.status.ext_fetch_error?.trim() ?? null;
                      const localExplainLine =
                        localExplainRaw ??
                        (lr.status.local === 'await_manual_download'
                          ? '链接不支持自动拉取，请自行下载并放入暂存目录'
                          : null);
                      const extExplainLine = extExplainRaw;
                      const feishuExplainRaw = lr.status.feishu_scan_error?.trim() ?? null;
                      const feishuLabel = lr.status.feishu
                        ? BOM_ROW_FEISHU_STATUS_LABEL[lr.status.feishu]
                        : BOM_ROW_FEISHU_STATUS_LABEL.not_scanned;
                      const statusExplainTitle =
                        [
                          extExplainLine ? `ext：${extExplainLine}` : null,
                          localExplainLine ? `本地：${localExplainLine}` : null,
                          feishuExplainRaw ? `飞书：${feishuExplainRaw}` : null,
                        ]
                          .filter(Boolean)
                          .join('\n') || undefined;
                      const canFeishuStubRow = lr.status.local === 'verified_ok';

                      return (
                        <tr key={lr.id} className="border-b last:border-b-0">
                          <td className="px-3 py-2 text-slate-500 whitespace-nowrap align-middle w-12">{i + 1}</td>
                          <td className="px-3 py-2 align-middle w-14 text-center">
                            <button
                              type="button"
                              onClick={() => stubExternalPullRow()}
                              title="从外部 Artifactory 拉取本行（开发中）"
                              className="inline-flex items-center justify-center p-1 rounded-md border border-sky-200 bg-sky-50 text-sky-900 hover:bg-sky-100"
                            >
                              <Download size={14} />
                            </button>
                          </td>
                          <td className="px-3 py-2 align-middle w-14 text-center">
                            {canFeishuStubRow ? (
                              <button
                                type="button"
                                onClick={() => stubFeishuUploadRow()}
                                title="上传到飞书网盘（开发中）"
                                className="inline-flex items-center justify-center p-1 rounded-md border border-violet-200 bg-violet-50 text-violet-900 hover:bg-violet-100"
                              >
                                <UploadCloud size={14} />
                              </button>
                            ) : (
                              <span className="text-slate-300">—</span>
                            )}
                          </td>
                          <td className="px-3 py-2 align-middle min-w-[9.5rem] max-w-[11rem] w-[10rem]">
                            <div
                              className={`rounded-md border px-2 py-1 text-left leading-snug ${badgeClass}`}
                              title={
                                indexedMd5Hit === false &&
                                (lr.status.local === 'verified_ok' ||
                                  lr.status.local === 'verified_fail' ||
                                  lr.status.local === 'local_found' ||
                                  lr.status.ext === 'synced_or_skipped')
                                  ? `整行状态：${formatBomRowStatusTooltip(lr.status)}。本地侧显示为「文件不存在」：local_file 中无此期望 MD5（可能已删除或未扫描）；可「刷新」按索引重算状态。`
                                  : `整行状态：${formatBomRowStatusTooltip(lr.status)}。含 ext、本地、飞书。`
                              }
                            >
                              <div className="text-[11px] font-medium">ext：{extLabel}</div>
                              <div className="text-[11px] font-medium mt-0.5">本地：{localLabel}</div>
                              <div className="text-[11px] font-medium mt-0.5 text-violet-900/90">飞书：{feishuLabel}</div>
                            </div>
                          </td>
                          <td
                            className="px-3 py-2 align-middle min-w-[10rem] max-w-[14rem] w-[12rem] text-slate-700"
                            title={statusExplainTitle}
                          >
                            <div className="text-left text-[11px] leading-snug line-clamp-3 whitespace-pre-line break-words text-slate-800">
                              <span className="font-medium text-slate-600">ext：</span>
                              <span>{extExplainLine ?? '—'}</span>
                            </div>
                            <div className="text-left text-[11px] leading-snug mt-1.5 pt-1.5 border-t border-slate-100 line-clamp-3 whitespace-pre-line break-words">
                              <span className="font-medium text-slate-600">本地：</span>
                              <span
                                className={
                                  localExplainLine && lr.status.local === 'await_manual_download' && !localExplainRaw
                                    ? 'text-amber-900/90'
                                    : 'text-slate-800'
                                }
                              >
                                {localExplainLine ?? '—'}
                              </span>
                            </div>
                            <div className="text-left text-[11px] leading-snug mt-1.5 pt-1.5 border-t border-slate-100 line-clamp-3 whitespace-pre-line break-words">
                              <span className="font-medium text-slate-600">飞书：</span>
                              <span className="text-slate-800">{feishuExplainRaw ?? '—'}</span>
                            </div>
                          </td>
                          <td className="px-3 py-2 align-middle min-w-[10rem] max-w-[14rem] w-[12rem] text-slate-700">
                            {extUrlCell && /^https?:\/\//i.test(extUrlCell.trim()) ? (
                              <a
                                href={extUrlCell.trim()}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="line-clamp-3 text-left text-[11px] text-emerald-900/90 leading-snug break-all font-mono underline decoration-emerald-300/80 hover:text-emerald-950"
                                title={extUrlCell}
                              >
                                {extUrlCell}
                              </a>
                            ) : extUrlCell ? (
                              <span
                                className="line-clamp-3 text-left text-[11px] text-emerald-900/90 leading-snug break-all font-mono"
                                title={extUrlCell}
                              >
                                {extUrlCell}
                              </span>
                            ) : (
                              <span className="text-slate-400">—</span>
                            )}
                          </td>
                          <td className="px-3 py-2 align-middle min-w-[14rem] max-w-[28rem] w-[18rem]">
                            {localPath ? (
                              <span
                                className="block font-mono text-[11px] text-slate-800 break-all text-left leading-snug"
                                title={normalizeLocalRelativePath(localPath)}
                              >
                                {normalizeLocalRelativePath(localPath)}
                              </span>
                            ) : (
                              <span className="text-slate-400">—</span>
                            )}
                          </td>
                          <td className="px-3 py-2 align-middle w-[11rem] max-w-[11rem]">
                            <BomRowByteSizeCell localBytes={localB} extBytes={extB} remoteBytes={remoteB} />
                          </td>
                          {dataHeaders.map((h) => {
                            const linkOrMd5 =
                              headerIsDownloadColumn(h, tableKeyMap) || headerIsMd5Column(h, tableKeyMap);
                            const isRemark = headerMatchesAny(h, remarkHeaderKeys);
                            const cellRaw = String(r[h] ?? '').trim();
                            return (
                              <td
                                key={`${lr.id}-${h}`}
                                className={`px-3 py-2 text-slate-700 align-middle overflow-hidden ${
                                  linkOrMd5 ? 'max-w-[14rem] w-[14rem]' : isRemark ? 'min-w-[8rem] max-w-[14rem]' : 'max-w-[11rem]'
                                }`}
                              >
                                {isRemark ? (
                                  <span className="line-clamp-2 text-left text-[11px]" title={cellRaw || undefined}>
                                    {cellRaw || '—'}
                                  </span>
                                ) : (
                                  <BomDataTableCell header={h} value={r[h] ?? ''} keyMap={tableKeyMap} />
                                )}
                              </td>
                            );
                          })}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <p className="mt-3 text-xs text-slate-500">
              状态在每次<strong>扫描任务成功结束</strong>后按期望 MD5 与{' '}
              <code className="bg-slate-100 px-1 rounded">local_file</code> 索引刷新；点此页「刷新」可拉取最新。
            </p>
            <p className="text-xs text-slate-500">
              飞书状态由上方「扫描飞书云盘」写入「状态 / 状态说明」；「上传」仍为 worker 接入前占位。
            </p>
          </>
        ) : loading ? (
          <p className="text-sm text-slate-500 flex items-center gap-2">
            <Loader2 size={16} className="animate-spin text-slate-400" />
            加载中…
          </p>
        ) : (
          <p className="text-sm text-slate-500">该版本暂无已入库行数据。</p>
        )}
        {existingHeaders.length >= 32 ? (
          <p className="text-xs text-slate-500">列数过多时仅展示前 32 列。</p>
        ) : null}
      </div>
    </div>
  );
};
