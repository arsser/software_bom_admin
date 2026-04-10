import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowLeft,
  ClipboardCopy,
  Hash,
  Search,
  Upload,
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
  updateBomBatchMeta,
  fetchBomBatchById,
  fetchBomRows,
  fetchLocalFileInfoByMd5,
  refreshBomRowStatusesForBatch,
  type LocalFileIndexInfo,
  mergeHeaderOrder,
  parsePastedBom,
  parsePastedFromClipboard,
  replaceBatchRows,
  updateBomBatchHeaderOrder,
  updateBomRowBomAndFetchError,
  updateBomRowRecord,
  validateRequiredHeaders,
  type BomBatchRow,
  type BomRowRecord,
} from '../lib/bomBatches';
import { enrichBomRowsFromArtifactory } from '../lib/bomArtifactoryEnrich';
import { enrichBomRowsRemoteSizeFromArtifactory } from '../lib/bomArtifactorySizes';
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
  BOM_EXT_SYNC_JOB_STATUS_LABEL,
  cancelBomExtSyncJob,
  extSyncJobIsTerminal,
  extSyncJobProgressPercent,
  fetchBomExtSyncJobsForBatch,
  requestBomExtSync,
  type BomExtSyncJob,
} from '../lib/bomExtSyncJobs';
import { checkCopyExtForBomRow, type BomExtCheckCopyResult } from '../lib/bomExtArtifactoryCheckCopy';
import {
  buildCopyCommandsForExtRows,
  buildCopyCommandsForRows,
  rowHasArtifactoryHttpUrl,
  rowHasExtArtifactoryHttpUrl,
} from '../lib/bomDownloadCommands';
import {
  extractExpectedMd5FromRow,
  extractExtUrlFromRow,
  extractDownloadUrlRaw,
  extractHttpUrlFromDownloadCell,
  extractExtSizeBytesFromRow,
  extractRemoteSizeBytesFromRow,
  normalizeLocalRelativePath,
  headerMatchesAny,
  remarkColumnKeys,
  rowEligibleForExtSync,
  rowEligibleForExtCheckCopy,
  rowEligibleForItPull,
  deriveLocalExtStatusLabels,
  rowExtUiComplete,
} from '../lib/bomRowFields';
import { BomRowByteSizeCell } from './HumanByteSize';
import { BomDataTableCell, headerIsDownloadColumn, headerIsMd5Column } from '../lib/bomTableCell';
import { formatBomRowStatusTooltip } from '../lib/bomRowStatus';
import {
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
  const [metaSaveLoading, setMetaSaveLoading] = useState(false);

  const [batchName, setBatchName] = useState('');
  const [selectedProductId, setSelectedProductId] = useState('');
  const [initialBatchName, setInitialBatchName] = useState('');
  const [initialProductId, setInitialProductId] = useState('');
  const [products, setProducts] = useState<Product[]>([]);

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
  /** local_file 按 MD5 查询完成后为 true，避免加载中空窗期误判「文件不存在」 */
  const [localIndexReady, setLocalIndexReady] = useState(true);
  const [artifactoryEnrichLoading, setArtifactoryEnrichLoading] = useState(false);
  const [artifactoryRemoteSizeLoading, setArtifactoryRemoteSizeLoading] = useState(false);
  const [downloadJobs, setDownloadJobs] = useState<BomDownloadJob[]>([]);
  /** 'all' | 行 id | null */
  const [downloadBusy, setDownloadBusy] = useState<'all' | string | null>(null);
  const [downloadCancelBusy, setDownloadCancelBusy] = useState(false);
  const downloadJobStatusRef = useRef<Map<string, string>>(new Map());
  const [extSyncJobs, setExtSyncJobs] = useState<BomExtSyncJob[]>([]);
  const [extSyncBusy, setExtSyncBusy] = useState<'all' | string | null>(null);
  const [extSyncCancelBusy, setExtSyncCancelBusy] = useState(false);
  const extSyncJobStatusRef = useRef<Map<string, string>>(new Map());
  const [extCheckBusy, setExtCheckBusy] = useState(false);
  const [extCheckLastDetailText, setExtCheckLastDetailText] = useState<string | null>(null);
  const [extCheckDetailToast, setExtCheckDetailToast] = useState<string | null>(null);
  const [showAdvancedTools, setShowAdvancedTools] = useState(false);
  const [showExtAdvancedTools, setShowExtAdvancedTools] = useState(false);
  /** 已入库表格：勾选用于复制 curl/wget 的行 id（内部 Artifactory / BOM 下载列） */
  const [copyRowIds, setCopyRowIds] = useState<Set<string>>(() => new Set());
  /** 勾选用于复制 ext 转存链接 curl/wget 的行 id */
  const [extCopyRowIds, setExtCopyRowIds] = useState<Set<string>>(() => new Set());
  const [copyCmdToast, setCopyCmdToast] = useState<string | null>(null);
  const [extCopyCmdToast, setExtCopyCmdToast] = useState<string | null>(null);
  /** 已入库表格：仅显示本地侧非「校验通过」的行（与「只看本地校验未通过」一致） */
  const [filterStoredLocalNotVerifiedOk, setFilterStoredLocalNotVerifiedOk] = useState(false);
  /** 已入库表格：仅显示 ext 侧未完成行（与表格 ext「已完成」判定一致，含已写入 ext 链接） */
  const [filterStoredExtNotComplete, setFilterStoredExtNotComplete] = useState(false);

  // 编辑模式下：用于控制「覆盖 BOM 清单」按钮可用性（仅 BOM 原始内容是否相对上次入库有改动）
  // 覆盖保存成功后，把 lastSavedPastedText 更新为当前 pastedText；之后 pastedText 未改动则按钮置灰。
  const [lastSavedPastedText, setLastSavedPastedText] = useState<string | null>(null);

  const pasteAreaRef = useRef<HTMLDivElement>(null);
  const PASTE_AREA_HINT = '在此处 Ctrl/Cmd+V 粘贴 Excel 区域';

  function escapeDelimitedCell(v: string, delimiter: '\t' | ',' | '|'): string {
    const s = String(v ?? '');
    const needsQuote = s.includes('"') || s.includes('\n') || s.includes('\r') || s.includes(delimiter);
    const normalized = s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    if (!needsQuote) return normalized;
    return `"${normalized.replace(/"/g, '""')}"`;
  }

  function stringifyBomToPasteText(headers: string[], rows: BomRowRecord[]): string {
    const delimiter: '\t' = '\t';
    const safeHeaders = headers.map((h) => (h ?? '').trim()).filter(Boolean);
    if (!safeHeaders.length) throw new Error('无法生成 BOM 原始内容：缺少表头');
    const headerLine = safeHeaders.join(delimiter);
    const lines = rows.map((r) =>
      safeHeaders.map((h) => escapeDelimitedCell(r?.[h] ?? '', delimiter)).join(delimiter),
    );
    return [headerLine, ...lines].join('\n');
  }

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

  /** 动态 BOM 列：保留导入表头顺序（含备注列）；仅排除系统单独展示的体积/ext 直链列 */
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
        if (!b) throw new Error('未找到该版本');
        setBatchName(b.name);
        setInitialBatchName(b.name);
        setSelectedProductId(b.productId);
        setInitialProductId(b.productId);
        setBatchHeaderOrder(b.headerOrder ?? []);

        try {
          await refreshBomRowStatusesForBatch(batchId);
        } catch (e) {
          console.warn(
            'WARN refreshBomRowStatusesForBatch',
            e instanceof Error ? e.message : String(e),
          );
        }

        const rows = await fetchBomRows(batchId);
        setLoadedBomRows(rows);
        setSelectedRows(rows.map((x) => x.bom_row));

        // 反向生成 BOM 原始内容：用于预览与「覆盖并保存」；高级文本框默认折叠
        try {
          const headerFromDb = Array.isArray(b.headerOrder) && b.headerOrder.length ? b.headerOrder : [];
          const firstRow = rows[0]?.bom_row ?? {};
          const firstKeys = Object.keys(firstRow);
          const seen = new Set(headerFromDb.map((h) => String(h).trim()));
          const mergedHeaders = [...headerFromDb];
          for (const k of firstKeys) {
            const t = String(k ?? '').trim();
            if (!t) continue;
            if (seen.has(t)) continue;
            mergedHeaders.push(t);
            seen.add(t);
            if (mergedHeaders.length >= 64) break;
          }

          const raw = rows.length ? stringifyBomToPasteText(mergedHeaders, rows.map((x) => x.bom_row)) : '';
          setPastedText(raw);
          setShowRawInput(false);
          setLastSavedPastedText(raw);

          const parsed = parsePastedBom(raw);
          setPreviewHeaders(parsed.headers);
          setPreviewRows(parsed.rows);

          const headerCheck = validateRequiredHeaders(parsed.headers, scanner.jsonKeyMap);
          if (!headerCheck.ok) {
            const missingText = headerCheck.missingGroups
              .map((g) => (g === 'downloadUrl' ? 'downloadUrl（下载路径）' : 'expectedMd5（期望MD5）'))
              .join('、');
            setPreviewHeaderError(`列头缺少必需列组：${missingText}。该表将不能入库。`);
          } else {
            setPreviewHeaderError('');
          }
        } catch (e) {
          // 生成失败不影响页面加载
          console.warn('WARN build raw BOM from db failed', e instanceof Error ? e.message : String(e));
        }
        try {
          const [jobs, extJobs] = await Promise.all([
            fetchBomDownloadJobsForBatch(batchId),
            fetchBomExtSyncJobsForBatch(batchId),
          ]);
          setDownloadJobs(jobs);
          setExtSyncJobs(extJobs);
        } catch {
          setDownloadJobs([]);
          setExtSyncJobs([]);
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
    extSyncJobStatusRef.current = new Map();
    setCopyRowIds(new Set());
    load();
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

  const eligiblePullCount = useMemo(() => {
    if (!config) return 0;
    return loadedBomRows.filter((lr) => rowEligibleForItPull(lr, tableKeyMap, localInfoByMd5)).length;
  }, [loadedBomRows, config, tableKeyMap, localInfoByMd5]);

  const eligibleExtSyncCount = useMemo(() => {
    if (!config) return 0;
    return loadedBomRows.filter((lr) => rowEligibleForExtSync(lr, tableKeyMap)).length;
  }, [loadedBomRows, config, tableKeyMap]);

  const missingMd5Count = useMemo(() => {
    if (!config) return 0;
    return loadedBomRows.filter((lr) => {
      const md5 = extractExpectedMd5FromRow(lr.bom_row, tableKeyMap);
      if (md5) return false;
      const raw = extractDownloadUrlRaw(lr.bom_row, tableKeyMap);
      const url = raw ? extractHttpUrlFromDownloadCell(raw) : null;
      if (!url) return false;
      return /artifactory/i.test(url);
    }).length;
  }, [loadedBomRows, config, tableKeyMap]);

  const artifactoryRemoteSizeRowCount = useMemo(() => {
    if (!config) return 0;
    return loadedBomRows.filter((lr) => rowHasArtifactoryHttpUrl(lr, tableKeyMap)).length;
  }, [loadedBomRows, config, tableKeyMap]);

  const copyableRowIds = useMemo(() => {
    if (!config) return [] as string[];
    return loadedBomRows.filter((lr) => rowHasArtifactoryHttpUrl(lr, tableKeyMap)).map((lr) => lr.id);
  }, [loadedBomRows, config, tableKeyMap]);

  const allCopyableRowsSelected = useMemo(
    () => copyableRowIds.length > 0 && copyableRowIds.every((id) => copyRowIds.has(id)),
    [copyableRowIds, copyRowIds],
  );

  const extCopyableRowIds = useMemo(() => {
    if (!config) return [] as string[];
    return loadedBomRows.filter((lr) => rowHasExtArtifactoryHttpUrl(lr, tableKeyMap)).map((lr) => lr.id);
  }, [loadedBomRows, config, tableKeyMap]);

  const allExtCopyableRowsSelected = useMemo(
    () => extCopyableRowIds.length > 0 && extCopyableRowIds.every((id) => extCopyRowIds.has(id)),
    [extCopyableRowIds, extCopyRowIds],
  );

  const filteredStoredBomRows = useMemo(() => {
    return loadedBomRows.filter((lr) => {
      if (filterStoredLocalNotVerifiedOk && lr.status.local === 'verified_ok') return false;
      if (filterStoredExtNotComplete && rowExtUiComplete(lr, tableKeyMap)) return false;
      return true;
    });
  }, [loadedBomRows, filterStoredLocalNotVerifiedOk, filterStoredExtNotComplete, tableKeyMap]);

  const hasActiveDownloadJob = useMemo(
    () => downloadJobs.some((j) => j.status === 'queued' || j.status === 'running'),
    [downloadJobs],
  );

  const latestDownloadJob = downloadJobs[0] ?? null;
  const activeDownloadJobToCancel = useMemo(
    () => downloadJobs.find((j) => j.status === 'queued' || j.status === 'running') ?? null,
    [downloadJobs],
  );

  const hasActiveExtSyncJob = useMemo(
    () => extSyncJobs.some((j) => j.status === 'queued' || j.status === 'running'),
    [extSyncJobs],
  );
  const latestExtSyncJob = extSyncJobs[0] ?? null;
  const activeExtSyncJobToCancel = useMemo(
    () => extSyncJobs.find((j) => j.status === 'queued' || j.status === 'running') ?? null,
    [extSyncJobs],
  );

  useEffect(() => {
    if (!batchId || !hasActiveDownloadJob) return;
    const id = window.setInterval(() => {
      void fetchBomDownloadJobsForBatch(batchId).then(setDownloadJobs);
    }, 1500);
    return () => window.clearInterval(id);
  }, [batchId, hasActiveDownloadJob]);

  useEffect(() => {
    if (!batchId || !hasActiveExtSyncJob) return;
    const id = window.setInterval(() => {
      void fetchBomExtSyncJobsForBatch(batchId).then(setExtSyncJobs);
    }, 1500);
    return () => window.clearInterval(id);
  }, [batchId, hasActiveExtSyncJob]);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅在任务状态从进行中变为终态时刷新版本数据
  }, [downloadJobs]);

  useEffect(() => {
    for (const j of extSyncJobs) {
      const prev = extSyncJobStatusRef.current.get(j.id);
      extSyncJobStatusRef.current.set(j.id, j.status);
      if ((prev === 'queued' || prev === 'running') && extSyncJobIsTerminal(j.status)) {
        void load();
        break;
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [extSyncJobs]);

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

  const handleCancelDownloadJob = async (jobId: string) => {
    if (!batchId) return;
    setDownloadCancelBusy(true);
    try {
      const ok = await cancelBomDownloadJob(jobId);
      if (!ok) {
        alert('无法取消：任务已结束或无权操作。');
      }
      const jobs = await fetchBomDownloadJobsForBatch(batchId);
      setDownloadJobs(jobs);
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setDownloadCancelBusy(false);
    }
  };


  const handleExtSyncAll = async () => {
    if (!batchId) return;
    setExtSyncBusy('all');
    try {
      await requestBomExtSync(batchId, null);
      const jobs = await fetchBomExtSyncJobsForBatch(batchId);
      setExtSyncJobs(jobs);
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setExtSyncBusy(null);
    }
  };

  const handleExtCheckAll = async () => {
    if (!batchId) return;
    if (!config) return;
    if (extCheckBusy) return;

    setExtCheckBusy(true);
    try {
      const ids = loadedBomRows.map((lr) => lr.id);
      if (!ids.length) {
        alert('当前版本没有数据行');
        return;
      }

      const rowStatusById = new Map(loadedBomRows.map((lr) => [lr.id, lr.status]));
      setExtCheckLastDetailText(null);
      setExtCheckDetailToast(null);

      // 并发限制：避免同时开太多 ext checksum 请求
      const concurrency = 4;
      const results: BomExtCheckCopyResult[] = new Array(ids.length);
      let cursor = 0;

      const worker = async () => {
        while (true) {
          const idx = cursor;
          cursor += 1;
          if (idx >= ids.length) break;
          results[idx] = await checkCopyExtForBomRow(ids[idx]);
        }
      };

      await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, () => worker()));

      let nCopied = 0;
      let nNeedPutVerifiedOk = 0;
      let nNeedPutNonVerifiedOk = 0;
      let nError = 0;
      const sampleErrors: string[] = [];
      const detailErrors: string[] = [];
      const needPutNonVerifiedPhrase = 'ext 不存在，需本地下载并校验后再上传';
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        const id = ids[i];
        if (!r || !('ok' in r)) continue;
        if (r.ok && r.needPut) {
          if (rowStatusById.get(id)?.local === 'verified_ok') nNeedPutVerifiedOk += 1;
          else nNeedPutNonVerifiedOk += 1;
        } else if (r.ok && !r.needPut) {
          nCopied += 1;
        } else if (!r.ok) {
          nError += 1;
          if (sampleErrors.length < 3) sampleErrors.push(r.error);
          detailErrors.push(`row_id=${id} ${r.status ? `(status=${r.status})` : ''} ${r.error}`);
        }
      }

      const suffix = sampleErrors.length ? `（示例：${sampleErrors.join('；')}）` : '';
      const needPutNonVerifiedPart = nNeedPutNonVerifiedOk ? `；${nNeedPutNonVerifiedOk} 行：${needPutNonVerifiedPhrase}` : '';
      alert(`ext 全部检查完成：已 Copy ${nCopied}，需 PUT ${nNeedPutVerifiedOk}，失败 ${nError}${needPutNonVerifiedPart}${suffix}`);
      if (detailErrors.length) {
        setExtCheckLastDetailText(
          [`ext 全部检查失败详情`, `失败行数：${detailErrors.length}`, '', ...detailErrors].join('\n'),
        );
      } else {
        setExtCheckLastDetailText(null);
      }
      await load();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      alert(msg);
      setExtCheckLastDetailText(`ext 全部检查异常：\n${msg}`);
    } finally {
      setExtCheckBusy(false);
    }
  };

  const handleExtSyncOne = async (rowId: string) => {
    if (!batchId) return;
    setExtSyncBusy(rowId);
    try {
      const r = (await checkCopyExtForBomRow(rowId)) as BomExtCheckCopyResult;
      if (!r.ok) {
        alert('ext 快速查重/Copy 失败：' + r.error);
        return;
      }

      if (r.needPut) {
        const row = loadedBomRows.find((lr) => lr.id === rowId);
        if (row?.status.local !== 'verified_ok') {
          // ext 不存在但本地未校验通过：worker 无法 PUT，需要先下载并校验
          alert('ext 不存在，需本地下载并校验后再上传');
          return;
        }

        // 仅当本地确实存在对应文件时才允许上传（排队 worker PUT）
        const md5 = row ? extractExpectedMd5FromRow(row.bom_row, tableKeyMap) : null;
        if (!md5 || !localInfoByMd5.get(md5)?.path) {
          alert('本地无该文件，无法上传（请先拉取并校验通过后再同步 ext）');
          return;
        }

        // ext 不存在：交给 worker 做本地 PUT/上传
        await requestBomExtSync(batchId, [rowId]);
        const jobs = await fetchBomExtSyncJobsForBatch(batchId);
        setExtSyncJobs(jobs);
      } else {
        // 命中：edge 已 Copy + 写回 jsonb ext_url；直接刷新页面
        await load();
      }
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setExtSyncBusy(null);
    }
  };

  const handleCancelExtSyncJob = async (jobId: string) => {
    if (!batchId) return;
    setExtSyncCancelBusy(true);
    try {
      const ok = await cancelBomExtSyncJob(jobId);
      if (!ok) alert('无法取消：任务已结束或无权操作。');
      const jobs = await fetchBomExtSyncJobsForBatch(batchId);
      setExtSyncJobs(jobs);
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setExtSyncCancelBusy(false);
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

  const toggleExtCopyRowId = (rowId: string) => {
    setExtCopyRowIds((prev) => {
      const next = new Set(prev);
      if (next.has(rowId)) next.delete(rowId);
      else next.add(rowId);
      return next;
    });
  };

  const toggleSelectAllExtCopyableRows = () => {
    if (allExtCopyableRowsSelected) {
      setExtCopyRowIds(new Set());
    } else {
      setExtCopyRowIds(new Set(extCopyableRowIds));
    }
  };

  const toggleAdvancedTools = () => {
    setShowAdvancedTools((prev) => {
      const next = !prev;
      if (!next) {
        setCopyRowIds(new Set());
        setCopyCmdToast(null);
      }
      return next;
    });
  };

  const toggleExtAdvancedTools = () => {
    setShowExtAdvancedTools((prev) => {
      const next = !prev;
      if (!next) {
        setExtCopyRowIds(new Set());
        setExtCopyCmdToast(null);
      }
      return next;
    });
  };

  const handleCopyDownloadCommands = async (tool: 'curl' | 'wget') => {
    if (!config) return;
    const af = artifactoryConfig;
    if (!af) {
      alert('无法读取 Artifactory 配置，请稍后重试或检查系统设置。');
      return;
    }
    if (!(af.artifactoryApiKey || '').trim() && !(af.artifactoryExtApiKey || '').trim()) {
      alert('请先在「系统设置」中配置 Artifactory API Key（内部或外部）。');
      return;
    }
    const items = loadedBomRows
      .map((lr, idx) => ({ row: lr, displayLine: idx + 1 }))
      .filter(({ row }) => copyRowIds.has(row.id));
    if (items.length === 0) {
      alert('请先勾选表格左侧复选框（需为含 内部 Artifactory 链接的行）。');
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

  const handleCopyExtDownloadCommands = async (tool: 'curl' | 'wget') => {
    if (!config) return;
    const af = artifactoryConfig;
    if (!af) {
      alert('无法读取 Artifactory 配置，请稍后重试或检查系统设置。');
      return;
    }
    if (!(af.artifactoryApiKey || '').trim() && !(af.artifactoryExtApiKey || '').trim()) {
      alert('请先在「系统设置」中配置 Artifactory API Key（内部或外部）。');
      return;
    }
    const items = loadedBomRows
      .map((lr, idx) => ({ row: lr, displayLine: idx + 1 }))
      .filter(({ row }) => extCopyRowIds.has(row.id));
    if (items.length === 0) {
      alert('请先勾选「ext」列复选框（需为已写入 外部 Artifactory http(s) 链接的行）。');
      return;
    }
    const { text, errors } = buildCopyCommandsForExtRows(items, config.jsonKeyMap, af, tool);
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
      setExtCopyCmdToast(
        `已复制 ext ${label}（${items.length} 条命令${errors.length ? `，${errors.length} 条跳过` : ''}）`,
      );
      window.setTimeout(() => setExtCopyCmdToast(null), 4000);
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
      // 仅补全缺失 MD5 的行（且必须是 Artifactory http(s) 链接）
      const targets = loadedBomRows.filter((lr) => {
        const md5 = extractExpectedMd5FromRow(lr.bom_row, config.jsonKeyMap);
        if (md5) return false;
        const raw = extractDownloadUrlRaw(lr.bom_row, config.jsonKeyMap);
        const url = raw ? extractHttpUrlFromDownloadCell(raw) : null;
        if (!url) return false;
        return /artifactory/i.test(url);
      });
      if (targets.length === 0) {
        alert('没有缺失 MD5 且可从 Artifactory 补全的行。');
        return;
      }

      const { rows: enriched, summary } = await enrichBomRowsFromArtifactory(
        targets,
        config.jsonKeyMap,
        af,
      );
      const jm = config.jsonKeyMap;
      const toEnsure = [jm.fileSizeBytes?.[0]].filter(Boolean) as string[];
      const baseHo = batchHeaderOrder.length > 0 ? batchHeaderOrder : existingHeaders;
      const ho = mergeHeaderOrder([...baseHo], toEnsure);
      let persisted = 0;
      for (let i = 0; i < enriched.length; i += 1) {
        const a = targets[i];
        const b = enriched[i];
        if (!a || !b) continue;
        const bomChanged = JSON.stringify(a.bom_row) !== JSON.stringify(b.bom_row);
        const errChanged =
          (a.status.local_fetch_error ?? null) !== (b.status.local_fetch_error ?? null);
        if (bomChanged || errChanged) {
          await updateBomRowBomAndFetchError(b.id, b.bom_row, b.status.local_fetch_error ?? null);
          persisted += 1;
        }
      }
      if (toEnsure.length) await updateBomBatchHeaderOrder(batchId, ho);
      setBatchHeaderOrder(ho);
      await load();
      const parts: string[] = [
        `已保存变更 ${persisted} 行`,
        `参与 Storage API 的行：${summary.rowsWithDownloadUrl}`,
        `新补全 MD5：${summary.md5FilledCount} 行`,
      ];
      if (summary.apiRespondedErrorCount > 0) {
        parts.push(
          `API 返回失败 ${summary.apiRespondedErrorCount} 行（见各行「状态说明·本地」中的 Artifactory 摘要）`,
        );
      }
      if (summary.apiOkButNoMd5Count > 0) {
        parts.push(`API 成功但未返回可用 MD5：${summary.apiOkButNoMd5Count} 行`);
      }
      if (summary.skippedNoUrl > 0) {
        parts.push(`未发起请求（无可用 http(s) 下载路径）：${summary.skippedNoUrl} 行`);
      }
      if (summary.failedChunks > 0) {
        parts.push(
          `整批请求抛错 ${summary.failedChunks} 次：${summary.chunkErrorMessages.join('；')}`,
        );
      }
      alert(parts.join('\n'));
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setArtifactoryEnrichLoading(false);
    }
  };

  const handleArtifactoryRemoteSizes = async () => {
    if (!batchId || !config) return;
    const af = artifactoryConfig;
    if (!af) {
      alert('无法读取 Artifactory 配置，请稍后重试或检查系统设置。');
      return;
    }
    const targets = loadedBomRows.filter((lr) => rowHasArtifactoryHttpUrl(lr, config.jsonKeyMap));
    if (targets.length === 0) {
      alert('没有含 内部 Artifactory http(s) 下载路径的行。');
      return;
    }
    setArtifactoryRemoteSizeLoading(true);
    try {
      const { rows: enriched, summary } = await enrichBomRowsRemoteSizeFromArtifactory(
        targets,
        config.jsonKeyMap,
        af,
      );
      const jm = config.jsonKeyMap;
      const toEnsure = [jm.fileSizeBytes?.[0]].filter(Boolean) as string[];
      const baseHo = batchHeaderOrder.length > 0 ? batchHeaderOrder : existingHeaders;
      const ho = mergeHeaderOrder([...baseHo], toEnsure);
      let persisted = 0;
      for (let i = 0; i < enriched.length; i += 1) {
        const a = targets[i];
        const b = enriched[i];
        if (!a || !b) continue;
        if (JSON.stringify(a.bom_row) !== JSON.stringify(b.bom_row)) {
          await updateBomRowRecord(b.id, b.bom_row);
          persisted += 1;
        }
      }
      if (toEnsure.length) await updateBomBatchHeaderOrder(batchId, ho);
      setBatchHeaderOrder(ho);
      await load();
      const parts: string[] = [
        `已保存变更 ${persisted} 行`,
        `参与 Storage API 的行：${summary.rowsWithArtifactoryUrl}`,
        `写入/更新 it 大小列：${summary.sizeFilledCount} 行`,
      ];
      if (summary.apiRespondedErrorCount > 0) {
        parts.push(`API 返回失败 ${summary.apiRespondedErrorCount} 行`);
      }
      if (summary.apiOkButNoSizeCount > 0) {
        parts.push(`API 成功但未返回可用 size：${summary.apiOkButNoSizeCount} 行`);
      }
      if (summary.skippedNoUrl > 0) {
        parts.push(`未发起请求（无 内部 Artifactory 链接）：${summary.skippedNoUrl} 行`);
      }
      if (summary.failedChunks > 0) {
        parts.push(`整批请求抛错 ${summary.failedChunks} 次：${summary.chunkErrorMessages.join('；')}`);
      }
      alert(parts.join('\n'));
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setArtifactoryRemoteSizeLoading(false);
    }
  };

  const handleSaveMeta = async () => {
    if (isNew || !batchId) return;
    if (!selectedProductId) {
      alert('请选择产品');
      return;
    }
    if (!batchName.trim()) {
      alert('请填写版本名称');
      return;
    }
    setMetaSaveLoading(true);
    try {
      await updateBomBatchMeta(batchId, { name: batchName, productId: selectedProductId });
      setInitialBatchName(batchName);
      setInitialProductId(selectedProductId);
      setLastMessage('已保存版本信息（名称与所属产品）');
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setMetaSaveLoading(false);
    }
  };

  const handleSave = async () => {
    if (!config) return;
    if (!selectedProductId) {
      alert('请选择产品');
      return;
    }
    if (!batchName.trim()) {
      alert('请填写版本名称');
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
        setLastMessage(`已创建版本，共 ${parsed.rows.length} 行；告警 ${buildBomWarnings(parsed.rows, config.jsonKeyMap).length} 条`);
        navigate(`/bom/${id}`, { replace: true });
      } else {
        await updateBomBatchHeaderOrder(batchId, parsed.headers);
        await replaceBatchRows(batchId, parsed.rows);
        setBatchHeaderOrder(parsed.headers);
        setLastMessage(`已覆盖 BOM 清单，共 ${parsed.rows.length} 行；告警 ${buildBomWarnings(parsed.rows, config.jsonKeyMap).length} 条`);
        const refreshed = await fetchBomRows(batchId);
        setLoadedBomRows(refreshed);
        setSelectedRows(refreshed.map((x) => x.bom_row));
      }
      // 覆盖 BOM 清单后：按钮置灰直到用户再次修改 pastedText
      if (!isNew) setLastSavedPastedText(pastedText);
      // 新建版本：入库后页面跳转，清空输入框更符合预期
      // 覆盖保存：用户希望在高级输入框里仍能看到「BOM 原始内容」，因此不要清空。
      if (isNew) {
        setPastedText('');
        handleClearImportPreview();
      }
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setSaveLoading(false);
    }
  };

  const hasMetaChanged = !isNew && (
    batchName.trim() !== initialBatchName.trim() || selectedProductId !== initialProductId
  );
  const hasPastedChanged = isNew || lastSavedPastedText == null || pastedText !== lastSavedPastedText;
  const canSaveBomList = pastedText.trim().length > 0 && hasPastedChanged;

  return (
    <div className="max-w-[96rem] mx-auto space-y-5 pb-2">
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
            <h2 className="text-2xl font-bold text-slate-900 mt-1">{isNew ? '新建版本' : '编辑版本'}</h2>
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

      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 md:p-6 space-y-4">
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
            <div className="flex items-center justify-between gap-2 mb-1">
              <label className="block text-sm font-medium text-slate-700">版本名称</label>
              {!isNew ? (
                <button
                  type="button"
                  onClick={() => void handleSaveMeta()}
                  disabled={loading || metaSaveLoading || !hasMetaChanged}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md border border-indigo-200 bg-indigo-50 text-indigo-800 hover:bg-indigo-100 disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
                  title="保存版本名称与所属产品（不修改 BOM 清单）"
                >
                  {metaSaveLoading ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                  保存版本信息
                </button>
              ) : null}
            </div>
            <input
              type="text"
              value={batchName}
              onChange={(e) => setBatchName(e.target.value)}
              placeholder="例如：4.11 / 2026Q1 / release-xxx"
              className="w-full px-4 py-2 border border-gray-200 rounded-lg"
            />
          </div>
        </div>

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
            <div className="overflow-x-auto border border-gray-200 rounded-lg -mx-0.5">
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
            当前版本行数：{selectedRows.length}，告警：{selectedWarnings.length} 条（不阻断）
          </div>
          <button
            type="button"
            onClick={handleSave}
            disabled={saveLoading || !canSaveBomList}
            title={isNew ? undefined : '仅覆盖 BOM 清单（表头顺序与行数据），不修改版本名称与所属产品'}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-60"
          >
            {saveLoading ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
            {isNew ? '创建并入库' : '覆盖并保存'}
          </button>
        </div>

        {lastMessage ? <p className="text-sm text-emerald-700">{lastMessage}</p> : null}
      </div>

      {!isNew ? (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 md:p-6 space-y-4">
          <h3 className="text-lg font-medium text-slate-800">已入库数据</h3>

          {loadedBomRows.length > 0 ? (
            <>
              <div className="rounded-lg border border-indigo-100 bg-indigo-50/90 p-3 md:p-4 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="text-sm font-medium text-indigo-950">内部 Artifactory</div>
                    
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void handleArtifactoryEnrich()}
                      disabled={artifactoryEnrichLoading || missingMd5Count === 0}
                      title="对含 内部 Artifactory 链接且缺 MD5 的行调用 Storage 信息补全"
                      className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-amber-300 bg-amber-50 text-amber-950 text-sm font-medium hover:bg-amber-100 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {artifactoryEnrichLoading ? <Loader2 size={16} className="animate-spin" /> : <Hash size={16} />}
                      补全缺失 MD5（{missingMd5Count}）
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleArtifactoryRemoteSizes()}
                      disabled={
                        artifactoryRemoteSizeLoading ||
                        artifactoryEnrichLoading ||
                        artifactoryRemoteSizeRowCount === 0
                      }
                      title="对含 内部 Artifactory 链接的行调用 Storage API，写回 jsonKeyMap.fileSizeBytes 别名列"
                      className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-slate-800 text-sm font-medium hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {artifactoryRemoteSizeLoading ? (
                        <Loader2 size={16} className="animate-spin" />
                      ) : (
                        <Search size={16} />
                      )}
                      检查（{artifactoryRemoteSizeRowCount}）
                    </button>
                    {activeDownloadJobToCancel ? (
                      <button
                        type="button"
                        disabled={downloadCancelBusy}
                        onClick={() => void handleCancelDownloadJob(activeDownloadJobToCancel.id)}
                        title={
                          activeDownloadJobToCancel.status === 'running'
                            ? '请求取消正在执行的拉取（再次点击可强制取消）'
                            : '取消排队中的拉取任务'
                        }
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-slate-700 text-sm font-medium hover:bg-slate-50 disabled:opacity-50"
                      >
                        {downloadCancelBusy ? (
                          <Loader2 size={16} className="animate-spin" />
                        ) : (
                          <XCircle size={16} />
                        )}
                        {activeDownloadJobToCancel.status === 'running' ? '取消任务' : '取消排队'}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      disabled={eligiblePullCount === 0 || downloadBusy !== null || hasActiveDownloadJob}
                      onClick={() => void handleDownloadAllIt()}
                      className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-indigo-300 bg-white text-indigo-900 text-sm font-medium hover:bg-indigo-100 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {downloadBusy === 'all' ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
                      拉取（{eligiblePullCount}）
                    </button>
                  </div>
                </div>
                <div className="rounded-md border border-slate-200 bg-white/70 px-3 py-2 space-y-2">
                  <button
                    type="button"
                    onClick={toggleAdvancedTools}
                    className="text-xs font-medium text-slate-800 hover:text-slate-950"
                  >
                    {showAdvancedTools ? '▼' : '▶'} 高级/排障工具
                  </button>
                  {showAdvancedTools ? (
                    <div className="space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
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
                      {copyCmdToast ? (
                        <p className="text-xs text-emerald-800 font-medium px-0.5">{copyCmdToast}</p>
                      ) : null}
                      <p className="text-[11px] text-slate-600 leading-snug">
                        在下方表格「it」列（展开本工具后显示）勾选含 BOM 下载列 内部 Artifactory 链接的行，再复制终端命令（与 worker 相同 Bearer 与 JFrog 头）。命令含敏感信息，请勿泄露剪贴板内容。ext 转存链接请在 外部 Artifactory 卡片展开「高级/排障工具」。
                      </p>
                    </div>
                  ) : null}
                </div>
                
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

              <div className="rounded-lg border border-emerald-100 bg-emerald-50/90 p-3 md:p-4 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="text-sm font-medium text-emerald-950">外部 Artifactory</div>
                    
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {activeExtSyncJobToCancel ? (
                      <button
                        type="button"
                        disabled={extSyncCancelBusy}
                        onClick={() => void handleCancelExtSyncJob(activeExtSyncJobToCancel.id)}
                        title={
                          activeExtSyncJobToCancel.status === 'running'
                            ? '请求取消正在执行的 ext 同步（再次点击可强制取消）'
                            : '取消排队中的 ext 同步任务'
                        }
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-slate-700 text-sm font-medium hover:bg-slate-50 disabled:opacity-50"
                      >
                        {extSyncCancelBusy ? (
                          <Loader2 size={16} className="animate-spin" />
                        ) : (
                          <XCircle size={16} />
                        )}
                        {activeExtSyncJobToCancel.status === 'running' ? '取消任务' : '取消排队'}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      disabled={
                        extCheckBusy ||
                        loadedBomRows.length === 0 ||
                        hasActiveExtSyncJob ||
                        !(config?.extArtifactoryRepo ?? '').trim()
                      }
                      onClick={() => void handleExtCheckAll()}
                      className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-slate-700 text-sm font-medium hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed"
                      title="对当前版本全部行执行 ext 查重（checksum search + Copy）；无 MD5 等将记为失败"
                    >
                      {extCheckBusy ? <Loader2 size={16} className="animate-spin" /> : <Search size={16} />}
                      检查（{loadedBomRows.length}）
                    </button>
                    <button
                      type="button"
                      disabled={
                        eligibleExtSyncCount === 0 ||
                        extSyncBusy !== null ||
                        hasActiveExtSyncJob ||
                        !(config?.extArtifactoryRepo ?? '').trim()
                      }
                      onClick={() => void handleExtSyncAll()}
                      className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-emerald-300 bg-white text-emerald-900 text-sm font-medium hover:bg-emerald-100 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {extSyncBusy === 'all' ? (
                        <Loader2 size={16} className="animate-spin" />
                      ) : (
                        <Upload size={16} />
                      )}
                      上传（{eligibleExtSyncCount}）
                    </button>
                  </div>
                </div>
                <div className="rounded-md border border-slate-200 bg-white/70 px-3 py-2 space-y-2">
                  <button
                    type="button"
                    onClick={toggleExtAdvancedTools}
                    className="text-xs font-medium text-slate-800 hover:text-slate-950"
                  >
                    {showExtAdvancedTools ? '▼' : '▶'} 高级/排障工具
                  </button>
                  {showExtAdvancedTools ? (
                    <div className="space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={() => void handleCopyExtDownloadCommands('curl')}
                          disabled={extCopyRowIds.size === 0}
                          title="按 ext_url 等列复制选中行的 curl 命令（含 Authorization 与 X-JFrog-Art-Api）"
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-slate-800 text-sm font-medium hover:bg-slate-50 disabled:opacity-45 disabled:cursor-not-allowed"
                        >
                          <ClipboardCopy size={16} />
                          复制 curl
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleCopyExtDownloadCommands('wget')}
                          disabled={extCopyRowIds.size === 0}
                          title="按 ext 链接复制选中行的 wget 命令"
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-slate-800 text-sm font-medium hover:bg-slate-50 disabled:opacity-45 disabled:cursor-not-allowed"
                        >
                          <ClipboardCopy size={16} />
                          复制 wget
                        </button>
                      </div>
                      {extCopyCmdToast ? (
                        <p className="text-xs text-emerald-800 font-medium px-0.5">{extCopyCmdToast}</p>
                      ) : null}
                      <p className="text-[11px] text-slate-600 leading-snug">
                        在下方表格「ext」列（展开本工具后显示；若同时展开 it 高级工具则在第二列复选）勾选含 外部 Artifactory 转存链接的行，再复制终端命令（与 worker 相同 Bearer 与 JFrog 头）。命令含敏感信息，请勿泄露剪贴板内容。
                      </p>
                    </div>
                  ) : null}
                </div>
                {extCheckLastDetailText ? (
                  <div className="rounded-md border border-rose-200 bg-white/90 px-3 py-2.5 space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-xs text-rose-900/90 font-medium">失败详情（可复制）</p>
                      <button
                        type="button"
                        className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md border border-rose-200 bg-white text-rose-900 text-xs hover:bg-rose-50 disabled:opacity-50"
                        onClick={async () => {
                          try {
                            if (!extCheckLastDetailText) return;
                            await navigator.clipboard.writeText(extCheckLastDetailText);
                            setExtCheckDetailToast('已复制');
                            window.setTimeout(() => setExtCheckDetailToast(null), 1500);
                          } catch {
                            alert('复制失败：请手动选中内容复制。');
                          }
                        }}
                      >
                        <ClipboardCopy size={14} />
                        复制
                      </button>
                    </div>
                    {extCheckDetailToast ? (
                      <p className="text-[11px] text-rose-900/80">{extCheckDetailToast}</p>
                    ) : null}
                    <textarea
                      readOnly
                      value={extCheckLastDetailText}
                      className="w-full h-28 font-mono text-[11px] text-slate-800 bg-slate-50 border border-slate-200 rounded-md px-2.5 py-2"
                    />
                  </div>
                ) : null}
                {!(config?.extArtifactoryRepo ?? '').trim() ? (
                  <p className="text-xs text-amber-900 bg-amber-50 border border-amber-200 rounded-md px-2.5 py-2">
                    请先在<strong>系统设置 → BOM 本地扫描</strong>中填写 <span className="font-mono">外部 Artifactory 目标仓库 key</span>。
                  </p>
                ) : null}
                {latestExtSyncJob ? (
                  <div className="rounded-md border border-emerald-200/80 bg-white/90 px-3 py-2.5 space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-emerald-950">
                      <span className="font-medium">
                        {BOM_EXT_SYNC_JOB_STATUS_LABEL[latestExtSyncJob.status]}
                      </span>
                      <span className="font-mono text-emerald-800/90">
                        {latestExtSyncJob.progressTotal > 0
                          ? `${latestExtSyncJob.progressCurrent}/${latestExtSyncJob.progressTotal}`
                          : '—'}
                      </span>
                    </div>
                    <div className="h-2 w-full rounded-full bg-emerald-100 overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all duration-300 ${
                          latestExtSyncJob.status === 'cancelled' ? 'bg-slate-400' : 'bg-emerald-600'
                        }`}
                        style={{
                          width: `${extSyncJobProgressPercent(latestExtSyncJob)}%`,
                        }}
                      />
                    </div>
                    {latestExtSyncJob.lastMessage ? (
                      <p className="text-[11px] text-emerald-900/90 font-mono break-all leading-snug">
                        {latestExtSyncJob.lastMessage}
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </div>

              <div className="flex flex-col gap-1.5 items-start text-sm text-slate-700 -mx-0.5">
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
                    <span title="隐藏 ext 侧已完成的行（已写入转存链接，或状态为已转存/跳过）">只看 ext 未完成</span>
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
                      {showAdvancedTools ? (
                        <th
                          className="px-2 py-2 text-center font-semibold text-slate-700 border-b border-gray-200 whitespace-nowrap w-9"
                          title="it：BOM 下载列 · 全选含 内部 Artifactory 链接的行"
                        >
                          <input
                            type="checkbox"
                            checked={allCopyableRowsSelected}
                            disabled={copyableRowIds.length === 0}
                            onChange={toggleSelectAllCopyableRows}
                            aria-label="全选 内部 Artifactory 可复制行"
                            className="h-3.5 w-3.5 rounded border-slate-400 align-middle cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                          />
                        </th>
                      ) : null}
                      {showExtAdvancedTools ? (
                        <th
                          className="px-2 py-2 text-center font-semibold text-slate-700 border-b border-gray-200 whitespace-nowrap w-9"
                          title="ext：转存链接列 · 全选含 外部 Artifactory 链接的行"
                        >
                          <input
                            type="checkbox"
                            checked={allExtCopyableRowsSelected}
                            disabled={extCopyableRowIds.length === 0}
                            onChange={toggleSelectAllExtCopyableRows}
                            aria-label="全选 外部 Artifactory 可复制行"
                            className="h-3.5 w-3.5 rounded border-slate-400 align-middle cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                          />
                        </th>
                      ) : null}
                      <th className="px-3 py-2 text-center font-semibold text-slate-700 border-b border-gray-200 whitespace-nowrap w-14">
                        拉取
                      </th>
                      <th className="px-3 py-2 text-center font-semibold text-slate-700 border-b border-gray-200 whitespace-nowrap w-14">
                        上传
                      </th>
                      <th
                        className="px-3 py-2 text-left font-semibold text-slate-700 border-b border-gray-200 whitespace-nowrap min-w-[9.5rem] max-w-[11rem] w-[10rem]"
                        title="上行：ext（转存是否完成）；下行：本地（暂存/校验）。均由现有 status 与 ext_url 等推导。"
                      >
                        状态
                      </th>
                      <th
                        className="px-3 py-2 text-left font-semibold text-slate-700 border-b border-gray-200 whitespace-nowrap min-w-[10rem] max-w-[14rem] w-[12rem]"
                        title="与「状态」列对应：上行「ext」为 status.ext_fetch_error；下行「本地」为 status.local_fetch_error；与 local/ext 枚举同条 JSON。"
                      >
                        状态说明
                      </th>
                      <th
                        className="px-3 py-2 text-left font-semibold text-slate-700 border-b border-gray-200 whitespace-nowrap min-w-[10rem] max-w-[14rem] w-[12rem]"
                        title="jsonb 中 ext_url 等别名对应的可下载 URI（阶段 5 同步后写入）"
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
                      /** 优先 ext：已转存完成一律绿色；ext 未开始时沿用原先按 local 的配色 */
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
                      const canPullThis = rowEligibleForItPull(lr, tableKeyMap, localInfoByMd5);
                      const canExtSyncThisRow =
                        lr.status.local === 'verified_ok' &&
                        rowEligibleForExtCheckCopy(lr, tableKeyMap) &&
                        Boolean(localPath);
                      const extUrlCell = extractExtUrlFromRow(r, tableKeyMap);
                      const canCopyCmd = rowHasArtifactoryHttpUrl(lr, tableKeyMap);
                      const canExtCopyCmd = rowHasExtArtifactoryHttpUrl(lr, tableKeyMap);
                      const localExplainRaw = lr.status.local_fetch_error?.trim() ?? null;
                      const extExplainRaw = lr.status.ext_fetch_error?.trim() ?? null;
                      const localExplainLine =
                        localExplainRaw ??
                        (lr.status.local === 'await_manual_download'
                          ? '链接不支持自动拉取，请自行下载并放入暂存目录'
                          : null);
                      const extExplainLine = extExplainRaw;
                      const statusExplainTitle =
                        [
                          extExplainLine ? `ext：${extExplainLine}` : null,
                          localExplainLine ? `本地：${localExplainLine}` : null,
                        ]
                          .filter(Boolean)
                          .join('\n') || undefined;
                      return (
                        <tr key={lr.id} className="border-b last:border-b-0">
                          <td className="px-3 py-2 text-slate-500 whitespace-nowrap align-middle w-12">{i + 1}</td>
                          {showAdvancedTools ? (
                            <td className="px-2 py-2 align-middle w-9 text-center">
                              <input
                                type="checkbox"
                                checked={copyRowIds.has(lr.id)}
                                disabled={!canCopyCmd}
                                onChange={() => toggleCopyRowId(lr.id)}
                                title={canCopyCmd ? '勾选后可批量复制 it 侧 curl/wget' : '无 内部 Artifactory 链接'}
                                className="h-3.5 w-3.5 rounded border-slate-400 align-middle cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                              />
                            </td>
                          ) : null}
                          {showExtAdvancedTools ? (
                            <td className="px-2 py-2 align-middle w-9 text-center">
                              <input
                                type="checkbox"
                                checked={extCopyRowIds.has(lr.id)}
                                disabled={!canExtCopyCmd}
                                onChange={() => toggleExtCopyRowId(lr.id)}
                                title={
                                  canExtCopyCmd
                                    ? '勾选后可批量复制 ext 侧 curl/wget'
                                    : '无 外部 Artifactory 链接（需先有 ext_url 等）'
                                }
                                className="h-3.5 w-3.5 rounded border-slate-400 align-middle cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                              />
                            </td>
                          ) : null}
                          <td className="px-3 py-2 align-middle w-14 text-center">
                            {canPullThis ? (
                              <button
                                type="button"
                                disabled={downloadBusy !== null || hasActiveDownloadJob}
                                onClick={() => void handleDownloadOneIt(lr.id)}
                                title="拉取本行 内部 Artifactory 制品"
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
                          <td className="px-3 py-2 align-middle w-14 text-center">
                            {canExtSyncThisRow ? (
                              <button
                                type="button"
                                disabled={
                                  extSyncBusy !== null ||
                                  hasActiveExtSyncJob ||
                                  !(config?.extArtifactoryRepo ?? '').trim()
                                }
                                onClick={() => void handleExtSyncOne(lr.id)}
                                title="本地已有文件：查重并 Copy 到 ext 版本目录（必要时排队 PUT）；无本地文件请用顶部「外部 Artifactory 全部检查」"
                                className="inline-flex items-center justify-center p-1 rounded-md border border-emerald-200 bg-emerald-50 text-emerald-900 hover:bg-emerald-100 disabled:opacity-45 disabled:cursor-not-allowed"
                              >
                                {extSyncBusy === lr.id ? (
                                  <Loader2 size={14} className="animate-spin" />
                                ) : (
                                  <Upload size={14} />
                                )}
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
                                  ? `整行状态：${formatBomRowStatusTooltip(lr.status)}。本地侧显示为「文件不存在」：local_file 中无此期望 MD5（可能已删除或未扫描）；可点「拉取」重新下载，或「刷新」按索引重算状态。`
                                  : `整行状态：${formatBomRowStatusTooltip(lr.status)}。上行为 ext，下行为本地。`
                              }
                            >
                              <div className="text-[11px] font-medium">
                                ext：{extLabel}
                              </div>
                              <div className="text-[11px] font-medium mt-0.5">
                                本地：{localLabel}
                              </div>
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
                              <span className="line-clamp-3 text-left text-[11px] text-emerald-900/90 leading-snug break-all font-mono" title={extUrlCell}>
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
            </>
          ) : (
            <p className="text-sm text-slate-500">该版本暂无已入库行数据。</p>
          )}
          {existingHeaders.length >= 32 ? (
            <p className="text-xs text-slate-500">列数过多时仅展示前 32 列。</p>
          ) : null}
        </div>
      ) : null}

      {!isNew ? (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 md:p-6 space-y-3">
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

