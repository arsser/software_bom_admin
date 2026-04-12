import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
import {
  defaultBomScannerConfig,
  fetchBomScannerSettings,
  type BomJsonKeyMap,
  type BomScannerConfig,
} from '../lib/bomScannerSettings';
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
  extractGroupSegmentFromRow,
  fileBasename,
  normalizeBomKeyForMatch,
  normalizeLocalRelativePath,
  headerMatchesAny,
  remarkColumnKeys,
  deriveLocalExtStatusLabels,
  rowEligibleForDistributeExternalPull,
} from '../lib/bomRowFields';
import {
  BOM_ROW_EXT_STATUS_LABEL,
  BOM_ROW_FEISHU_STATUS_LABEL,
  BOM_ROW_LOCAL_STATUS_LABEL,
  type BomRowStatusJson,
} from '../lib/bomRowStatus';
import { formatBytesHuman } from '../lib/bytesFormat';
import { requestBomDistributeExtPull } from '../lib/bomDownloadJobs';
import { requestBomFeishuScan } from '../lib/bomFeishuScan';
import { requestBomFeishuUpload, fetchBomFeishuUploadJobsForBatch, type BomFeishuUploadJob } from '../lib/bomFeishuUploadJobs';
import { BomDataTableCell, headerIsDownloadColumn, headerIsMd5Column } from '../lib/bomTableCell';

/** 分发页 tooltip：await_manual_download 在文案上显示为「待处理」，枚举值仍保留在括号内 */
function formatDistributePageBomRowStatusTooltip(s: BomRowStatusJson): string {
  const localZh =
    s.local === 'await_manual_download' ? '待处理' : BOM_ROW_LOCAL_STATUS_LABEL[s.local];
  const feishuPart =
    s.feishu != null
      ? `；飞书：${BOM_ROW_FEISHU_STATUS_LABEL[s.feishu]}（${s.feishu}）`
      : '；飞书：未扫描';
  return `本地：${localZh}（${s.local}）；ext：${BOM_ROW_EXT_STATUS_LABEL[s.ext]}（${s.ext}）${feishuPart}`;
}

/** 本地已校验通过且已跑过飞书扫描、且飞书侧非「已对齐」时，允许点击上传并入队 worker */
function feishuRowEligibleForUploadStub(status: BomRowStatusJson): boolean {
  if (status.local !== 'verified_ok') return false;
  const f = status.feishu;
  if (f == null || f === 'not_scanned') return false;
  return f === 'absent' || f === 'error';
}

/** 下拉「无分组」与 BOM 中空字符串对应；勿与真实分组名冲突（极罕见） */
const GROUP_FILTER_ALL = '';
const GROUP_FILTER_EMPTY = '\u0000bom_dist_no_group\u0000';

function rowGroupSegmentRaw(row: BomBatchRow['bom_row'], keyMap: BomJsonKeyMap): string {
  return extractGroupSegmentFromRow(row, keyMap) ?? '';
}

/**
 * 拉取 / 上传 按钮显示逻辑（分发页）：
 * - 表头「全部拉取」：至少一行可拉取时可点；文案为全表总行数、待拉取（本地非 verified_ok）、可拉取（待拉取且含有效 ext 链接）。
 * - 行内「拉取」：仅当本地非「校验通过」且存在有效 ext http(s) 链接时显示按钮；本地已通过则始终「—」。
 * - 行内「上传」：仅当 feishuRowEligibleForUploadStub 为真时显示按钮；本地已通过但飞书未扫描显示「…」；否则「—」。
 * - 「上传选中到飞书」：作用域 = 当前表格筛选后的行 ∩ 复选框勾选的行；仅对满足 feishuRowEligibleForUploadStub 的行入队 bom_feishu_upload_jobs。
 */

/** BOM 分发页：只读表格 + 本地/外部状态查看；拉取（外部 AF）；飞书上传经队列由 worker 执行 */
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
  const [groupSegmentFilter, setGroupSegmentFilter] = useState<string>(GROUP_FILTER_ALL);
  /** 飞书上传范围：与「当前表格筛选结果」取交后的选中行 id */
  const [selectedUploadRowIds, setSelectedUploadRowIds] = useState<Set<string>>(() => new Set());
  const [feishuScanBusy, setFeishuScanBusy] = useState(false);
  const [feishuUploadBusy, setFeishuUploadBusy] = useState(false);
  const [distributeExtPullBusy, setDistributeExtPullBusy] = useState(false);
  const [activeFeishuJobs, setActiveFeishuJobs] = useState<BomFeishuUploadJob[]>([]);
  const feishuJobActive = activeFeishuJobs.some((j) => j.status === 'queued' || j.status === 'running');
  /** 扫描时若飞书根下无版本名文件夹，是否自动 create_folder（与 Edge batchDir 规则一致） */
  const [feishuAutoCreateVersionFolder, setFeishuAutoCreateVersionFolder] = useState(false);
  const uploadSelectAllHeaderRef = useRef<HTMLInputElement>(null);

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
      if (normalizeBomKeyForMatch(h) === 'ext_sync_kind') return false;
      if (sizeKeys.length && headerMatchesAny(h, sizeKeys)) return false;
      if (extSizeKeys.length && headerMatchesAny(h, extSizeKeys)) return false;
      if (extUrlKeys.length && headerMatchesAny(h, extUrlKeys)) return false;
      return true;
    });
  }, [existingHeaders, tableKeyMap]);

  const remarkHeaderKeys = useMemo(() => remarkColumnKeys(tableKeyMap), [tableKeyMap]);

  const filteredStoredBomRows = useMemo(() => {
    return loadedBomRows.filter((lr) => {
      if (groupSegmentFilter !== GROUP_FILTER_ALL) {
        const seg = rowGroupSegmentRaw(lr.bom_row, tableKeyMap);
        const want = groupSegmentFilter === GROUP_FILTER_EMPTY ? '' : groupSegmentFilter;
        if (seg !== want) return false;
      }
      return true;
    });
  }, [loadedBomRows, groupSegmentFilter, tableKeyMap]);

  const groupSegmentFilterOptions = useMemo(() => {
    const seen = new Set<string>();
    for (const lr of loadedBomRows) {
      seen.add(rowGroupSegmentRaw(lr.bom_row, tableKeyMap));
    }
    const opts: { value: string; label: string }[] = [{ value: GROUP_FILTER_ALL, label: '全部分组' }];
    const rest = Array.from(seen).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
    for (const seg of rest) {
      if (seg === '') opts.push({ value: GROUP_FILTER_EMPTY, label: '（无分组）' });
      else opts.push({ value: seg, label: seg });
    }
    return opts;
  }, [loadedBomRows, tableKeyMap]);

  /** 全表本地尚未校验通过的行数（按钮文案「待拉取」） */
  const eligibleExternalPullStubCount = useMemo(
    () => loadedBomRows.filter((lr) => lr.status.local !== 'verified_ok').length,
    [loadedBomRows],
  );
  /** 当前表格筛选内、本地非「校验通过」行数（与表头拉取统计对照用） */
  const eligibleExternalPullStubFilteredCount = useMemo(
    () => filteredStoredBomRows.filter((lr) => lr.status.local !== 'verified_ok').length,
    [filteredStoredBomRows],
  );
  /** 本地非校验通过且具备可请求 ext 链接、行内会出现拉取按钮的行数 */
  const distributeExternalPullUrlRowCount = useMemo(
    () => loadedBomRows.filter((lr) => rowEligibleForDistributeExternalPull(lr, tableKeyMap)).length,
    [loadedBomRows, tableKeyMap],
  );
  /** 全表：已本地校验通过且飞书扫描结论为「待上传/异常」的行数 */
  const feishuUploadStubCount = useMemo(
    () => loadedBomRows.filter((lr) => feishuRowEligibleForUploadStub(lr.status)).length,
    [loadedBomRows],
  );
  /** 当前筛选列表内、满足行内「上传」条件的行数 */
  const feishuUploadStubCountFiltered = useMemo(
    () => filteredStoredBomRows.filter((lr) => feishuRowEligibleForUploadStub(lr.status)).length,
    [filteredStoredBomRows],
  );

  /** 当前筛选下列内上传按钮会显示的行（与复选框可勾选范围一致） */
  const uploadSelectableFilteredRows = useMemo(
    () => filteredStoredBomRows.filter((lr) => feishuRowEligibleForUploadStub(lr.status)),
    [filteredStoredBomRows],
  );

  const uploadScopeRows = useMemo(
    () => filteredStoredBomRows.filter((lr) => selectedUploadRowIds.has(lr.id)),
    [filteredStoredBomRows, selectedUploadRowIds],
  );
  const uploadScopeEligibleRows = useMemo(
    () => uploadScopeRows.filter((lr) => feishuRowEligibleForUploadStub(lr.status)),
    [uploadScopeRows],
  );

  const selectedUploadableInFilterCount = useMemo(
    () => uploadSelectableFilteredRows.filter((lr) => selectedUploadRowIds.has(lr.id)).length,
    [uploadSelectableFilteredRows, selectedUploadRowIds],
  );
  const allFilteredUploadSelected = useMemo(
    () =>
      uploadSelectableFilteredRows.length > 0 &&
      selectedUploadableInFilterCount === uploadSelectableFilteredRows.length,
    [uploadSelectableFilteredRows, selectedUploadableInFilterCount],
  );
  const someFilteredUploadSelected = useMemo(
    () =>
      selectedUploadableInFilterCount > 0 &&
      selectedUploadableInFilterCount < uploadSelectableFilteredRows.length,
    [uploadSelectableFilteredRows, selectedUploadableInFilterCount],
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

      const [rows, fJobs] = await Promise.all([
        fetchBomRows(batchId),
        fetchBomFeishuUploadJobsForBatch(batchId, 20),
      ]);
      setLoadedBomRows(rows);
      setActiveFeishuJobs(fJobs);
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
    setSelectedUploadRowIds(new Set());
    setGroupSegmentFilter(GROUP_FILTER_ALL);
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batchId]);

  useEffect(() => {
    if (!feishuJobActive || !batchId) return;
    const id = window.setInterval(() => {
      void fetchBomFeishuUploadJobsForBatch(batchId, 20).then(setActiveFeishuJobs);
    }, 3000);
    return () => window.clearInterval(id);
  }, [feishuJobActive, batchId]);

  useEffect(() => {
    const byId = new Map(loadedBomRows.map((lr) => [lr.id, lr] as const));
    setSelectedUploadRowIds((prev) => {
      const next = new Set<string>();
      for (const id of prev) {
        const lr = byId.get(id);
        if (lr && feishuRowEligibleForUploadStub(lr.status)) next.add(id);
      }
      if (next.size === prev.size) {
        let same = true;
        for (const id of prev) {
          if (!next.has(id)) {
            same = false;
            break;
          }
        }
        return same ? prev : next;
      }
      return next;
    });
  }, [loadedBomRows]);

  useEffect(() => {
    if (groupSegmentFilter === GROUP_FILTER_ALL) return;
    const exists = groupSegmentFilterOptions.some((o) => o.value === groupSegmentFilter);
    if (!exists) setGroupSegmentFilter(GROUP_FILTER_ALL);
  }, [groupSegmentFilter, groupSegmentFilterOptions]);

  useLayoutEffect(() => {
    const el = uploadSelectAllHeaderRef.current;
    if (!el) return;
    el.indeterminate = someFilteredUploadSelected && !allFilteredUploadSelected;
  }, [someFilteredUploadSelected, allFilteredUploadSelected]);

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

  const handleDistributeExtPullAll = async () => {
    if (!batchId) return;
    setDistributeExtPullBusy(true);
    try {
      const jobId = await requestBomDistributeExtPull(batchId, null);
      alert(
        `已创建分发拉取任务（仅从 ext 转存地址下载）。任务 ID：${jobId}\n` +
          `全表待拉取约 ${eligibleExternalPullStubCount} 行；本次入队以数据库 eligible 为准（与「可拉取」统计可能略有差异）。`,
      );
      await load();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setDistributeExtPullBusy(false);
    }
  };

  const handleDistributeExtPullRow = async (lr: BomBatchRow) => {
    if (!batchId || !rowEligibleForDistributeExternalPull(lr, tableKeyMap)) return;
    setDistributeExtPullBusy(true);
    try {
      const jobId = await requestBomDistributeExtPull(batchId, [lr.id]);
      alert(`已创建分发拉取任务（仅从 ext 转存）。任务 ID：${jobId}`);
      await load();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setDistributeExtPullBusy(false);
    }
  };

  const toggleUploadRowSelected = (rowId: string) => {
    setSelectedUploadRowIds((prev) => {
      const next = new Set(prev);
      if (next.has(rowId)) next.delete(rowId);
      else next.add(rowId);
      return next;
    });
  };

  const toggleSelectAllFilteredForUpload = () => {
    setSelectedUploadRowIds((prev) => {
      const selectable = filteredStoredBomRows.filter((lr) => feishuRowEligibleForUploadStub(lr.status));
      if (selectable.length === 0) return prev;
      const allOn = selectable.every((lr) => prev.has(lr.id));
      const next = new Set(prev);
      if (allOn) {
        for (const lr of selectable) next.delete(lr.id);
      } else {
        for (const lr of selectable) next.add(lr.id);
      }
      return next;
    });
  };

  const selectEligibleInFilteredView = () => {
    const ids = filteredStoredBomRows.filter((lr) => feishuRowEligibleForUploadStub(lr.status)).map((lr) => lr.id);
    setSelectedUploadRowIds(new Set(ids));
  };

  const clearUploadSelection = () => setSelectedUploadRowIds(new Set());

  const handleFeishuScan = async () => {
    if (!batchId) return;
    setFeishuScanBusy(true);
    try {
      const r = await requestBomFeishuScan(batchId, {
        autoCreateVersionFolder: feishuAutoCreateVersionFolder,
      });
      if (!r.ok) {
        alert(r.error);
        return;
      }
      alert(
        r.message ??
          `扫描完成：与飞书一致 ${r.rows_present}，待上传或不一致 ${r.rows_absent}，无法对账 ${r.rows_error}（见表格「飞书扫描错误」）`,
      );
      await load();
    } finally {
      setFeishuScanBusy(false);
    }
  };

  const handleFeishuUploadRows = async (rows: BomBatchRow[]) => {
    if (!batchId) return;
    const eligible = rows.filter((lr) => feishuRowEligibleForUploadStub(lr.status));
    if (eligible.length === 0) {
      alert('所选行中没有满足上传条件的行（需本地校验通过且飞书为 absent/error）。');
      return;
    }
    setFeishuUploadBusy(true);
    try {
      const jobId = await requestBomFeishuUpload(
        batchId,
        eligible.map((r) => r.id),
      );
      alert(
        `已创建飞书上传任务（排队由 bom-scanner-worker 执行）。任务 ID：${jobId}\n将自动创建版本目录/分组子目录（与扫描规则一致）；≤20MB 整文件上传，>20MB 自动分片上传（支持断点续传）。`,
      );
      await load();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setFeishuUploadBusy(false);
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
              只读查看已入库清单与状态；「拉取」仅从 ext 转存地址（须为可识别的 Artifactory https 链接）；「上传」将排队由 worker 写入飞书云盘。
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
            仅从 <strong>ext 转存</strong> 列的 URL 拉取（须含 artifactory 且为 https）；不读取「下载路径」列。本地已通过则不显示拉取；由 worker 消费队列。
          </p>
          <button
            type="button"
            disabled={
              distributeExtPullBusy || loadedBomRows.length === 0 || distributeExternalPullUrlRowCount === 0
            }
            onClick={() => void handleDistributeExtPullAll()}
            title={
              loadedBomRows.length === 0
                ? '暂无数据'
                : distributeExternalPullUrlRowCount === 0
                  ? '当前无可拉取行（可能均已本地校验通过，或均无有效 ext 转存链接）'
                  : '入队当前版本全部「分发 eligible」行（以数据库为准：ext 为 Artifactory https 且本地/md5 条件满足）'
            }
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-sky-300 bg-white text-sky-950 text-sm font-medium hover:bg-sky-100 disabled:opacity-50"
          >
            {distributeExtPullBusy ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
            全部拉取（全表共{loadedBomRows.length}行，待拉取{eligibleExternalPullStubCount}行，可拉取{distributeExternalPullUrlRowCount}行）
          </button>
          {loadedBomRows.length > 0 && distributeExternalPullUrlRowCount === 0 ? (
            <p className="text-[11px] text-amber-900">
              当前版本无可拉取行（均已本地校验通过，或未填写可请求的 ext 链接）；行内拉取列为「—」，「全部拉取」不可用。
            </p>
          ) : null}
          {loadedBomRows.length > 0 && groupSegmentFilter !== GROUP_FILTER_ALL ? (
            <p className="text-[11px] text-sky-900/80">
              当前列表内待拉取 {eligibleExternalPullStubFilteredCount} 行（随分组筛选变化，与按钮上全表「待拉取」口径相同、范围不同）。
            </p>
          ) : null}
        </div>

        <div className="rounded-lg border border-violet-200 bg-violet-50/90 p-3 md:p-4 space-y-2">
          <div className="text-sm font-medium text-violet-950">飞书网盘 · 扫描 / 上传</div>
          <p className="text-xs text-violet-900/90">
            扫描：在飞书根目录下按版本名文件夹 +（组件或分组）+ 本地文件名 查找文件，读取飞书字节数，与{' '}
            <code className="bg-violet-100/80 px-1 rounded text-[10px]">local_file</code> 索引比对文件名与大小；不经
            worker、不用 MD5。上传：入队后由 worker 使用 upload_all（≤20MB）写入飞书，并自动创建版本/分组目录。
          </p>
          <div className="flex flex-wrap items-center gap-2 gap-x-3">
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
            <label className="inline-flex items-center gap-2 text-xs text-violet-900 select-none cursor-pointer shrink-0">
              <input
                type="checkbox"
                checked={feishuAutoCreateVersionFolder}
                onChange={(e) => setFeishuAutoCreateVersionFolder(e.target.checked)}
                disabled={feishuScanBusy || !(config?.feishuDriveRootFolderToken ?? '').trim()}
                className="rounded border-violet-400 text-violet-700 focus:ring-violet-500"
              />
              <span title="在配置的飞书根目录下，若无与当前版本名一致的文件夹，则先创建再扫描（文件夹名与扫描规则中的版本目录一致）">
                自动创建版本文件夹
              </span>
            </label>
            <button
              type="button"
              disabled={
                feishuUploadBusy ||
                feishuJobActive ||
                !(config?.feishuDriveRootFolderToken ?? '').trim() ||
                uploadScopeRows.length === 0
              }
              title={
                feishuJobActive
                  ? '已有飞书上传任务进行中，请等待完成或在后台任务页取消'
                  : uploadScopeRows.length === 0
                    ? '请先在表格中勾选要上传的行（须为当前筛选后的列表内）'
                    : uploadScopeEligibleRows.length === 0
                      ? '所选行中暂无满足上传条件的行（需本地校验通过且飞书已扫描为待上传或扫描异常）'
                      : '上传范围：当前筛选 ∩ 勾选；仅实际上传满足条件的行（worker 异步）'
              }
              onClick={() => void handleFeishuUploadRows(uploadScopeRows)}
              className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-violet-300 bg-white text-violet-950 text-sm font-medium hover:bg-violet-100 disabled:opacity-50"
            >
              {feishuUploadBusy || feishuJobActive ? <Loader2 size={16} className="animate-spin" /> : <UploadCloud size={16} />}
              上传选中到飞书（可执行 {uploadScopeEligibleRows.length} / 已选 {uploadScopeRows.length}）
            </button>
          </div>
          {loadedBomRows.length > 0 ? (
            <p className="text-[11px] text-violet-900/85">
              全表可上传约 {feishuUploadStubCount} 行；当前筛选下列表内可上传约 {feishuUploadStubCountFiltered} 行（与是否勾选无关）。
            </p>
          ) : null}
          {feishuJobActive ? (
            <p className="text-xs text-amber-900 font-medium">
              飞书上传任务进行中（
              {activeFeishuJobs
                .filter((j) => j.status === 'queued' || j.status === 'running')
                .map((j) =>
                  j.status === 'running'
                    ? `${j.progressCurrent}/${j.progressTotal} 行`
                    : '排队中',
                )
                .join('；')}
              ），上传按钮已禁用。可在
              <button
                type="button"
                onClick={() => navigate('/bom/jobs')}
                className="underline text-violet-900 hover:text-violet-700 mx-0.5"
              >
                后台任务页
              </button>
              查看详情或取消。
            </p>
          ) : null}
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
                <label className="inline-flex items-center gap-2 select-none text-slate-700">
                  <span className="text-xs shrink-0" title="与扫描/飞书路径中的分组子目录一致（jsonKeyMap.groupSegment）">
                    分组
                  </span>
                  <select
                    value={groupSegmentFilter}
                    onChange={(e) => setGroupSegmentFilter(e.target.value)}
                    className="h-7 rounded-md border border-slate-300 bg-white px-2 text-xs text-slate-800 max-w-[12rem] min-w-[6rem]"
                  >
                    {groupSegmentFilterOptions.map((o) => (
                      <option key={o.value === GROUP_FILTER_ALL ? '__all__' : o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </label>
                <span className="hidden sm:inline w-px h-5 bg-slate-200 self-center" aria-hidden />
                <button
                  type="button"
                  onClick={() => selectEligibleInFilteredView()}
                  disabled={feishuUploadStubCountFiltered === 0}
                  title="在当前筛选结果中，勾选所有满足「行内上传」条件的行"
                  className="text-xs font-medium text-indigo-700 hover:text-indigo-900 disabled:text-slate-400 disabled:cursor-not-allowed"
                >
                  在列表中全选可上传
                </button>
                <button
                  type="button"
                  onClick={() => clearUploadSelection()}
                  disabled={selectedUploadRowIds.size === 0}
                  className="text-xs font-medium text-slate-600 hover:text-slate-900 disabled:text-slate-400 disabled:cursor-not-allowed"
                >
                  清除勾选
                </button>
              </div>
              {groupSegmentFilter !== GROUP_FILTER_ALL ? (
                <span className="text-xs text-slate-500">
                  列表显示 {filteredStoredBomRows.length} / {loadedBomRows.length} 行
                  {uploadScopeRows.length > 0
                    ? `；上传勾选 ${uploadScopeRows.length} 行（其中 ${uploadScopeEligibleRows.length} 行可执行上传）`
                    : null}
                </span>
              ) : uploadScopeRows.length > 0 ? (
                <span className="text-xs text-slate-500">
                  上传勾选 {uploadScopeRows.length} 行（其中 {uploadScopeEligibleRows.length} 行可执行上传）
                </span>
              ) : null}
            </div>

            {filteredStoredBomRows.length === 0 ? (
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                当前分组下没有匹配行，请更换分组或选「全部分组」。
              </div>
            ) : (
              <div className="overflow-x-auto border border-gray-200 rounded-lg -mx-0.5">
                <table className="min-w-full text-xs table-fixed">
                  <thead className="bg-slate-50">
                    <tr>
                      <th className="px-3 py-2 text-left font-semibold text-slate-700 border-b border-gray-200 whitespace-nowrap w-12">
                        行号
                      </th>
                      <th className="px-3 py-2 text-center font-semibold text-slate-700 border-b border-gray-200 whitespace-nowrap w-10">
                        <input
                          ref={uploadSelectAllHeaderRef}
                          type="checkbox"
                          checked={allFilteredUploadSelected && filteredStoredBomRows.length > 0}
                          onChange={() => toggleSelectAllFilteredForUpload()}
                          disabled={filteredStoredBomRows.length === 0}
                          title="勾选或取消当前筛选列表中的全部行（上传范围 = 筛选 ∩ 勾选）"
                          className="h-3.5 w-3.5 rounded border-slate-400 text-indigo-600 focus:ring-indigo-500"
                          aria-label="全选当前列表"
                        />
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
                        className="px-3 py-2 text-left font-semibold text-slate-700 border-b border-gray-200 min-w-[10rem] max-w-[20rem] w-[14rem]"
                        title="优先显示本地索引文件名；无本地命中时显示飞书扫描文件名。悬停可查看双方。"
                      >
                        文件名
                      </th>
                      <th
                        className="px-3 py-2 text-left font-semibold text-slate-700 border-b border-gray-200 whitespace-nowrap min-w-[9rem] w-[11rem]"
                        title="本地索引字节数与飞书扫描字节数；飞书有值且与本地不一致时整格标红"
                      >
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
                      /** await_manual_download 在分发页与「待处理」同视觉（slate），不用琥珀色 */
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
                                  : 'bg-slate-100 text-slate-800 border-slate-200';
                      const indexedMd5Hit =
                        md5 != null && localIndexReady ? localInfoByMd5.has(md5) : null;
                      let { localLabel, extLabel } = deriveLocalExtStatusLabels(
                        lr,
                        tableKeyMap,
                        indexedMd5Hit,
                      );
                      if (lr.status.local === 'await_manual_download') {
                        localLabel = '待处理';
                      }
                      const extUrlCell = extractExtUrlFromRow(r, tableKeyMap);
                      const localExplainRaw = lr.status.local_fetch_error?.trim() ?? null;
                      const extExplainRaw = lr.status.ext_fetch_error?.trim() ?? null;
                      /** 分发页：await_manual_download 在状态格已标「待处理」，此处仅展示 local_fetch_error，否则 — */
                      const localExplainLine = localExplainRaw;
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
                      const canFeishuStubRow = feishuRowEligibleForUploadStub(lr.status);
                      const localVerifiedOk = lr.status.local === 'verified_ok';
                      const canExternalPullRow = rowEligibleForDistributeExternalPull(lr, tableKeyMap);
                      const feishuNameDisp = lr.status.feishu_file_name?.trim() ?? '';
                      const feishuSz = lr.status.feishu_size_bytes;

                      return (
                        <tr key={lr.id} className="border-b last:border-b-0">
                          <td className="px-3 py-2 text-slate-500 whitespace-nowrap align-middle w-12">{i + 1}</td>
                          <td className="px-3 py-2 align-middle w-10 text-center">
                            <input
                              type="checkbox"
                              disabled={!canFeishuStubRow}
                              checked={canFeishuStubRow && selectedUploadRowIds.has(lr.id)}
                              onChange={() => {
                                if (canFeishuStubRow) toggleUploadRowSelected(lr.id);
                              }}
                              title={
                                canFeishuStubRow
                                  ? '纳入「上传选中到飞书」范围'
                                  : '与本列上传按钮一致：仅本地校验通过且飞书已扫为待上传或扫描异常时可勾选'
                              }
                              className="h-3.5 w-3.5 rounded border-slate-400 text-indigo-600 focus:ring-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed"
                              aria-label={`选择第 ${i + 1} 行`}
                            />
                          </td>
                          <td className="px-3 py-2 align-middle w-14 text-center">
                            {canExternalPullRow ? (
                              <button
                                type="button"
                                disabled={distributeExtPullBusy}
                                onClick={() => void handleDistributeExtPullRow(lr)}
                                title="从 ext 转存地址拉取本行至本地（worker）；需本地未校验通过且 ext 为 Artifactory https"
                                className="inline-flex items-center justify-center p-1 rounded-md border border-sky-200 bg-sky-50 text-sky-900 hover:bg-sky-100 disabled:opacity-50"
                              >
                                <Download size={14} />
                              </button>
                            ) : (
                              <span
                                className="text-slate-300"
                                title={
                                  localVerifiedOk
                                    ? '本地已校验通过，无需从外部拉取'
                                    : '本行无有效的外部转存（ext）http(s) 链接，无法从远端拉取'
                                }
                              >
                                —
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-2 align-middle w-14 text-center">
                            {canFeishuStubRow ? (
                              <button
                                type="button"
                                disabled={feishuUploadBusy || feishuJobActive}
                                onClick={() => void handleFeishuUploadRows([lr])}
                                title={
                                  feishuJobActive
                                    ? '已有飞书上传任务进行中，请等待完成或在后台任务页取消'
                                    : '上传到飞书网盘（排队由 worker 执行）；需先扫描且飞书侧非已对齐'
                                }
                                className="inline-flex items-center justify-center p-1 rounded-md border border-violet-200 bg-violet-50 text-violet-900 hover:bg-violet-100 disabled:opacity-50"
                              >
                                <UploadCloud size={14} />
                              </button>
                            ) : lr.status.local === 'verified_ok' &&
                              (lr.status.feishu == null || lr.status.feishu === 'not_scanned') ? (
                              <span className="text-slate-400" title="请先执行「扫描飞书云盘」后再上传">
                                …
                              </span>
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
                                  ? `整行状态：${formatDistributePageBomRowStatusTooltip(lr.status)}。本地侧显示为「文件不存在」：local_file 中无此期望 MD5（可能已删除或未扫描）；可「刷新」按索引重算状态。`
                                  : `整行状态：${formatDistributePageBomRowStatusTooltip(lr.status)}。含 ext、本地、飞书。`
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
                              <span className="text-slate-800">{localExplainLine ?? '—'}</span>
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
                          <td className="px-3 py-2 align-middle min-w-[10rem] max-w-[20rem] w-[14rem]">
                            {(() => {
                              const localNorm = localPath ? normalizeLocalRelativePath(localPath) : '';
                              const localBase = localNorm ? fileBasename(localNorm) : '';
                              const feishuTrim = feishuNameDisp.trim();
                              const oneName = localBase || feishuTrim || '—';
                              let nameTitle: string | undefined;
                              if (localNorm && feishuTrim) {
                                nameTitle = `本地：${localNorm}\n飞书：${feishuTrim}`;
                              } else if (localNorm) {
                                nameTitle = localNorm;
                              } else if (feishuTrim) {
                                nameTitle = feishuTrim;
                              }
                              return (
                                <span
                                  className="block font-mono text-[11px] text-slate-800 break-all text-left leading-snug"
                                  title={nameTitle}
                                >
                                  {oneName}
                                </span>
                              );
                            })()}
                          </td>
                          <td className="px-3 py-2 align-middle min-w-[9rem] w-[11rem]">
                            {(() => {
                              const localHas =
                                localB != null && typeof localB === 'number' && Number.isFinite(localB);
                              const feishuHas =
                                typeof feishuSz === 'number' && Number.isFinite(feishuSz);
                              const localStr = localHas ? formatBytesHuman(localB) : '—';
                              const feishuStr = feishuHas ? formatBytesHuman(feishuSz) : '—';
                              const mismatch = feishuHas && localHas && localB !== feishuSz;
                              const cls = mismatch
                                ? 'text-[11px] leading-snug tabular-nums text-red-600 font-semibold'
                                : 'text-[11px] leading-snug tabular-nums text-slate-800';
                              const szTitle =
                                localHas && feishuHas
                                  ? `本地 ${localB} 字节\n飞书 ${feishuSz} 字节`
                                  : localHas
                                    ? `本地 ${localB} 字节`
                                    : feishuHas
                                      ? `飞书 ${feishuSz} 字节`
                                      : undefined;
                              return (
                                <div className={cls} title={szTitle}>
                                  <div>本地 {localStr}</div>
                                  <div className="mt-0.5">飞书 {feishuStr}</div>
                                </div>
                              );
                            })()}
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
              飞书文件名与大小由「扫描飞书云盘」写入（与「文件名」「大小」列合并展示）；已与飞书对齐的行上传按钮为灰；未扫描前本地已通过的行显示「…」。「上传选中到飞书」仅处理当前筛选下已勾选的行。
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
