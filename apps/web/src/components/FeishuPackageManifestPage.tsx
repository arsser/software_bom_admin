import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  ChevronsUpDown,
  ClipboardCopy,
  ExternalLink,
  Eye,
  FileJson,
  FolderOpen,
  GripHorizontal,
  Loader2,
  RefreshCw,
  Search,
  Table2,
  Trash2,
} from 'lucide-react';
import { fetchProducts, type Product } from '../lib/products';
import {
  deleteFeishuVersionSheet,
  fetchFeishuPackageManifest,
  fetchFeishuProductVersionDirs,
  requestFeishuPackageManifestRefresh,
  type FeishuPackageManifestEntry,
  type FeishuProductVersionDir,
} from '../lib/feishuPackageManifest';
import {
  BOM_FEISHU_MANIFEST_JOB_STATUS_LABEL,
  fetchBomFeishuManifestJobsForProduct,
  feishuManifestJobIsActive,
  type BomFeishuManifestJob,
} from '../lib/feishuPackageManifestJobs';
import {
  BOM_FEISHU_VERSION_SHEET_JOB_STATUS_LABEL,
  fetchBomFeishuVersionSheetJobsForBatch,
  feishuVersionSheetJobIsActive,
  requestBomFeishuVersionSheet,
  type BomFeishuVersionSheetJob,
} from '../lib/bomFeishuVersionSheet';

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '-';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatTime(iso: string | null | undefined): string {
  if (!iso) return '-';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

const META_COL_KEYS = [
  'rel_path',
  'file_name',
  'md5',
  'size',
  'download_url',
  'file_token',
  'uploaded_at',
] as const;
type MetaColKey = (typeof META_COL_KEYS)[number];

const META_COL_DEFAULT_WIDTHS: Record<MetaColKey, number> = {
  rel_path: 220,
  file_name: 160,
  md5: 240,
  size: 90,
  download_url: 280,
  file_token: 120,
  uploaded_at: 150,
};

const META_COL_MIN_WIDTH = 64;

const META_COL_LABELS: Record<MetaColKey, string> = {
  rel_path: '相对路径',
  file_name: '文件名',
  md5: 'MD5',
  size: '大小',
  download_url: '文件链接',
  file_token: 'file_token',
  uploaded_at: '上传时间',
};

const META_PANEL_MIN_H = 200;
const META_PANEL_MAX_H = 900;
const META_PANEL_DEFAULT_H = 360;

const DIR_COL_KEYS = ['name', 'created_at', 'batch', 'sheet', 'latest_job', 'actions'] as const;
type DirColKey = (typeof DIR_COL_KEYS)[number];

const DIR_COL_DEFAULT_WIDTHS: Record<DirColKey, number> = {
  name: 150,
  created_at: 150,
  batch: 130,
  sheet: 100,
  latest_job: 200,
  actions: 300,
};

const DIR_COL_MIN_WIDTH = 64;

const DIR_COL_LABELS: Record<DirColKey, string> = {
  name: '一级目录',
  created_at: '创建时间',
  batch: '关联批次',
  sheet: 'BOM 表',
  latest_job: '最近任务',
  actions: '操作',
};

const DIR_PANEL_MIN_H = 180;
const DIR_PANEL_MAX_H = 700;
const DIR_PANEL_DEFAULT_H = 280;

type TableSortDir = 'asc' | 'desc';

function entrySortValue(e: FeishuPackageManifestEntry, key: MetaColKey): string | number {
  switch (key) {
    case 'rel_path':
      return e.rel_path || '';
    case 'file_name':
      return e.file_name || '';
    case 'md5':
      return e.md5 || '';
    case 'size':
      return Number.isFinite(e.size_bytes) ? e.size_bytes : -1;
    case 'download_url':
      return e.download_url || '';
    case 'file_token':
      return e.file_token || '';
    case 'uploaded_at':
      return e.uploaded_at || '';
    default:
      return '';
  }
}

export const FeishuPackageManifestPage: React.FC = () => {
  const [products, setProducts] = useState<Product[]>([]);
  const [productId, setProductId] = useState('');
  const [loadingProducts, setLoadingProducts] = useState(true);
  const [loadingManifest, setLoadingManifest] = useState(false);
  const [loadingDirs, setLoadingDirs] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [exists, setExists] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [entries, setEntries] = useState<FeishuPackageManifestEntry[]>([]);
  const [jobs, setJobs] = useState<BomFeishuManifestJob[]>([]);
  const [dirs, setDirs] = useState<FeishuProductVersionDir[]>([]);
  const [sheetTitle, setSheetTitle] = useState('{产品}-{版本}-软件包清单');
  const [query, setQuery] = useState('');
  const [copiedToken, setCopiedToken] = useState<string | null>(null);
  const [generatingBatchId, setGeneratingBatchId] = useState<string | null>(null);
  const [deletingFolderToken, setDeletingFolderToken] = useState<string | null>(null);
  const [versionSheetJobsByBatch, setVersionSheetJobsByBatch] = useState<
    Record<string, BomFeishuVersionSheetJob[]>
  >({});
  const [metaColWidths, setMetaColWidths] = useState<Record<MetaColKey, number>>(() => ({
    ...META_COL_DEFAULT_WIDTHS,
  }));
  const [metaSortKey, setMetaSortKey] = useState<MetaColKey | null>(null);
  const [metaSortDir, setMetaSortDir] = useState<TableSortDir>('asc');
  const [metaPanelHeight, setMetaPanelHeight] = useState(META_PANEL_DEFAULT_H);
  const [dirQuery, setDirQuery] = useState('');
  const [dirColWidths, setDirColWidths] = useState<Record<DirColKey, number>>(() => ({
    ...DIR_COL_DEFAULT_WIDTHS,
  }));
  const [dirSortKey, setDirSortKey] = useState<DirColKey | null>('created_at');
  const [dirSortDir, setDirSortDir] = useState<TableSortDir>('desc');
  const [dirPanelHeight, setDirPanelHeight] = useState(DIR_PANEL_DEFAULT_H);
  const metaResizeRef = useRef<{
    key: MetaColKey;
    startX: number;
    startW: number;
  } | null>(null);
  const metaHeightResizeRef = useRef<{ startY: number; startH: number } | null>(null);
  const dirResizeRef = useRef<{
    key: DirColKey;
    startX: number;
    startW: number;
  } | null>(null);
  const dirHeightResizeRef = useRef<{ startY: number; startH: number } | null>(null);

  const metaTableWidth = useMemo(
    () => META_COL_KEYS.reduce((sum, k) => sum + metaColWidths[k], 0),
    [metaColWidths],
  );
  const dirTableWidth = useMemo(
    () => DIR_COL_KEYS.reduce((sum, k) => sum + dirColWidths[k], 0),
    [dirColWidths],
  );

  const onMetaColResizeStart = useCallback((key: MetaColKey, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    metaResizeRef.current = { key, startX: e.clientX, startW: metaColWidths[key] };
    const onMove = (ev: MouseEvent) => {
      const cur = metaResizeRef.current;
      if (!cur) return;
      const next = Math.max(META_COL_MIN_WIDTH, cur.startW + (ev.clientX - cur.startX));
      setMetaColWidths((prev) => (prev[cur.key] === next ? prev : { ...prev, [cur.key]: next }));
    };
    const onUp = () => {
      metaResizeRef.current = null;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [metaColWidths]);

  const onMetaPanelHeightResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      metaHeightResizeRef.current = { startY: e.clientY, startH: metaPanelHeight };
      const onMove = (ev: MouseEvent) => {
        const cur = metaHeightResizeRef.current;
        if (!cur) return;
        const next = Math.min(
          META_PANEL_MAX_H,
          Math.max(META_PANEL_MIN_H, cur.startH + (ev.clientY - cur.startY)),
        );
        setMetaPanelHeight(next);
      };
      const onUp = () => {
        metaHeightResizeRef.current = null;
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      };
      document.body.style.cursor = 'row-resize';
      document.body.style.userSelect = 'none';
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    },
    [metaPanelHeight],
  );

  const toggleMetaSort = useCallback((key: MetaColKey) => {
    setMetaSortKey((prev) => {
      if (prev !== key) {
        setMetaSortDir('asc');
        return key;
      }
      setMetaSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
      return key;
    });
  }, []);

  const onDirColResizeStart = useCallback((key: DirColKey, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dirResizeRef.current = { key, startX: e.clientX, startW: dirColWidths[key] };
    const onMove = (ev: MouseEvent) => {
      const cur = dirResizeRef.current;
      if (!cur) return;
      const next = Math.max(DIR_COL_MIN_WIDTH, cur.startW + (ev.clientX - cur.startX));
      setDirColWidths((prev) => (prev[cur.key] === next ? prev : { ...prev, [cur.key]: next }));
    };
    const onUp = () => {
      dirResizeRef.current = null;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [dirColWidths]);

  const onDirPanelHeightResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dirHeightResizeRef.current = { startY: e.clientY, startH: dirPanelHeight };
      const onMove = (ev: MouseEvent) => {
        const cur = dirHeightResizeRef.current;
        if (!cur) return;
        const next = Math.min(
          DIR_PANEL_MAX_H,
          Math.max(DIR_PANEL_MIN_H, cur.startH + (ev.clientY - cur.startY)),
        );
        setDirPanelHeight(next);
      };
      const onUp = () => {
        dirHeightResizeRef.current = null;
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      };
      document.body.style.cursor = 'row-resize';
      document.body.style.userSelect = 'none';
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    },
    [dirPanelHeight],
  );

  const toggleDirSort = useCallback((key: DirColKey) => {
    setDirSortKey((prev) => {
      if (prev !== key) {
        setDirSortDir('asc');
        return key;
      }
      setDirSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
      return key;
    });
  }, []);

  const selectedProduct = useMemo(
    () => products.find((p) => p.id === productId) ?? null,
    [products, productId],
  );

  const filteredEntries = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter((e) => {
      return (
        e.file_name.toLowerCase().includes(q) ||
        e.rel_path.toLowerCase().includes(q) ||
        e.md5.toLowerCase().includes(q) ||
        e.file_token.toLowerCase().includes(q)
      );
    });
  }, [entries, query]);

  const sortedEntries = useMemo(() => {
    if (!metaSortKey) return filteredEntries;
    const dir = metaSortDir === 'asc' ? 1 : -1;
    const key = metaSortKey;
    return [...filteredEntries].sort((a, b) => {
      const va = entrySortValue(a, key);
      const vb = entrySortValue(b, key);
      if (typeof va === 'number' && typeof vb === 'number') {
        if (va === vb) return 0;
        return va < vb ? -dir : dir;
      }
      return String(va).localeCompare(String(vb), 'zh', { numeric: true, sensitivity: 'base' }) * dir;
    });
  }, [filteredEntries, metaSortKey, metaSortDir]);

  const filteredSizeTotal = useMemo(
    () =>
      filteredEntries.reduce(
        (sum, e) => sum + (Number.isFinite(e.size_bytes) && e.size_bytes > 0 ? e.size_bytes : 0),
        0,
      ),
    [filteredEntries],
  );

  const activeJob = useMemo(() => jobs.find((j) => feishuManifestJobIsActive(j.status)) ?? null, [jobs]);

  const activeVersionSheetBatchIds = useMemo(() => {
    const ids = new Set<string>();
    for (const [batchId, list] of Object.entries(versionSheetJobsByBatch)) {
      if (list.some((j) => feishuVersionSheetJobIsActive(j.status))) ids.add(batchId);
    }
    return ids;
  }, [versionSheetJobsByBatch]);

  const loadProducts = useCallback(async () => {
    setLoadingProducts(true);
    try {
      const list = await fetchProducts();
      setProducts(list);
      setProductId((prev) => {
        if (prev && list.some((p) => p.id === prev)) return prev;
        const withRoot = list.find((p) => p.feishuDriveRootFolderToken);
        return withRoot?.id || list[0]?.id || '';
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingProducts(false);
    }
  }, []);

  const loadJobs = useCallback(async (pid: string) => {
    if (!pid) {
      setJobs([]);
      return;
    }
    try {
      const list = await fetchBomFeishuManifestJobsForProduct(pid, 8);
      setJobs(list);
    } catch (e) {
      console.warn('load manifest jobs', e);
    }
  }, []);

  const loadManifest = useCallback(async (pid: string) => {
    if (!pid) {
      setEntries([]);
      setExists(false);
      setUpdatedAt(null);
      return;
    }
    setLoadingManifest(true);
    setError(null);
    try {
      const res = await fetchFeishuPackageManifest(pid);
      if (!res.ok) {
        setError(res.error);
        setEntries([]);
        setExists(false);
        return;
      }
      setExists(res.exists);
      setUpdatedAt(res.updated_at);
      setEntries(res.entries);
      if (res.message) setInfo(res.message);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingManifest(false);
    }
  }, []);

  const loadVersionSheetJobsForDirs = useCallback(async (dirList: FeishuProductVersionDir[]) => {
    const batchIds = [...new Set(dirList.map((d) => d.batchId).filter((x): x is string => Boolean(x)))];
    if (!batchIds.length) {
      setVersionSheetJobsByBatch({});
      return;
    }
    const entriesPairs = await Promise.all(
      batchIds.map(async (batchId) => {
        try {
          const list = await fetchBomFeishuVersionSheetJobsForBatch(batchId, 4);
          return [batchId, list] as const;
        } catch {
          return [batchId, [] as BomFeishuVersionSheetJob[]] as const;
        }
      }),
    );
    setVersionSheetJobsByBatch(Object.fromEntries(entriesPairs));
  }, []);

  const loadDirs = useCallback(
    async (pid: string) => {
      if (!pid) {
        setDirs([]);
        setVersionSheetJobsByBatch({});
        return;
      }
      setLoadingDirs(true);
      try {
        const res = await fetchFeishuProductVersionDirs(pid);
        if (!res.ok) {
          setError(res.error);
          setDirs([]);
          return;
        }
        setSheetTitle(res.sheetTitlePattern || res.sheetTitle || '{产品}-{版本}-软件包清单');
        setDirs(res.dirs);
        await loadVersionSheetJobsForDirs(res.dirs);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoadingDirs(false);
      }
    },
    [loadVersionSheetJobsForDirs],
  );

  useEffect(() => {
    void loadProducts();
  }, [loadProducts]);

  useEffect(() => {
    if (!productId) return;
    void loadManifest(productId);
    void loadJobs(productId);
    void loadDirs(productId);
  }, [productId, loadManifest, loadJobs, loadDirs]);

  useEffect(() => {
    if (!productId || !activeJob) return;
    const t = window.setInterval(() => {
      void loadJobs(productId);
    }, 2500);
    return () => window.clearInterval(t);
  }, [productId, activeJob, loadJobs]);

  useEffect(() => {
    if (!productId || activeVersionSheetBatchIds.size === 0) return;
    const t = window.setInterval(() => {
      void loadVersionSheetJobsForDirs(dirs);
    }, 2500);
    return () => window.clearInterval(t);
  }, [productId, activeVersionSheetBatchIds.size, dirs, loadVersionSheetJobsForDirs]);

  const [prevActiveJobId, setPrevActiveJobId] = useState<string | null>(null);
  const [prevActiveVersionKeys, setPrevActiveVersionKeys] = useState<string>('');

  useEffect(() => {
    if (!productId) return;
    const curActive = jobs.find((j) => feishuManifestJobIsActive(j.status));
    if (prevActiveJobId && !curActive) {
      const finished = jobs.find((j) => j.id === prevActiveJobId);
      if (finished?.status === 'succeeded') {
        void loadManifest(productId);
        setInfo(finished.message || '扫描刷新完成');
      } else if (finished?.status === 'failed') {
        setError(finished.message || '扫描刷新失败');
      }
    }
    setPrevActiveJobId(curActive?.id ?? null);
  }, [jobs, productId, prevActiveJobId, loadManifest]);

  useEffect(() => {
    const activeKey = [...activeVersionSheetBatchIds].sort().join(',');
    if (prevActiveVersionKeys && !activeKey) {
      void loadDirs(productId);
      setInfo('版本 BOM 表任务已结束，已刷新目录状态');
    }
    setPrevActiveVersionKeys(activeKey);
  }, [activeVersionSheetBatchIds, prevActiveVersionKeys, productId, loadDirs]);

  const handleRefreshScan = async () => {
    if (!productId || refreshing || activeJob) return;
    setRefreshing(true);
    setError(null);
    setInfo(null);
    try {
      const res = await requestFeishuPackageManifestRefresh(productId);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setInfo(res.message || '已入队扫描刷新任务');
      await loadJobs(productId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRefreshing(false);
    }
  };

  const handleGenerateVersionSheet = async (dir: FeishuProductVersionDir) => {
    if (!dir.batchId) {
      setError(`目录「${dir.name}」未匹配到本产品 BOM 批次，无法生成表格`);
      return;
    }
    if (generatingBatchId || activeVersionSheetBatchIds.has(dir.batchId)) return;
    setGeneratingBatchId(dir.batchId);
    setError(null);
    setInfo(null);
    try {
      const r = await requestBomFeishuVersionSheet(dir.batchId);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setInfo(
        r.message ||
          `已排队生成「${dir.expectedSheetTitle || `${dir.name}-软件包清单`}」`,
      );
      await loadVersionSheetJobsForDirs(dirs);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setGeneratingBatchId(null);
    }
  };

  const handleDeleteVersionSheet = async (dir: FeishuProductVersionDir) => {
    if (!productId || !dir.folderToken || !dir.hasSheet) return;
    if (deletingFolderToken) return;
    const titleHint = dir.sheetTitle || dir.expectedSheetTitle || '软件包清单';
    const ok = window.confirm(`确定删除目录「${dir.name}」下的「${titleHint}」？此操作不可恢复。`);
    if (!ok) return;
    setDeletingFolderToken(dir.folderToken);
    setError(null);
    setInfo(null);
    try {
      const r = await deleteFeishuVersionSheet({
        productId,
        folderToken: dir.folderToken,
        sheetToken: dir.sheetToken,
      });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setInfo(r.message || `已删除「${dir.name}」下的「${titleHint}」`);
      await loadDirs(productId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDeletingFolderToken(null);
    }
  };

  const copyText = async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedToken(key);
      window.setTimeout(() => setCopiedToken((cur) => (cur === key ? null : cur)), 1500);
    } catch {
      setError('复制失败');
    }
  };

  const latestJobForBatch = (batchId: string | null): BomFeishuVersionSheetJob | null => {
    if (!batchId) return null;
    return versionSheetJobsByBatch[batchId]?.[0] ?? null;
  };

  const filteredDirs = useMemo(() => {
    const q = dirQuery.trim().toLowerCase();
    if (!q) return dirs;
    return dirs.filter((d) => {
      return (
        d.name.toLowerCase().includes(q) ||
        (d.batchName ?? '').toLowerCase().includes(q) ||
        (d.batchId ?? '').toLowerCase().includes(q) ||
        (d.sheetUrl ?? '').toLowerCase().includes(q)
      );
    });
  }, [dirs, dirQuery]);

  const sortedDirs = useMemo(() => {
    if (!dirSortKey) return filteredDirs;
    const dirMul = dirSortDir === 'asc' ? 1 : -1;
    const key = dirSortKey;
    return [...filteredDirs].sort((a, b) => {
      const latestA = a.batchId ? versionSheetJobsByBatch[a.batchId]?.[0] : null;
      const latestB = b.batchId ? versionSheetJobsByBatch[b.batchId]?.[0] : null;
      let va: string | number = '';
      let vb: string | number = '';
      switch (key) {
        case 'name':
          va = a.name;
          vb = b.name;
          break;
        case 'created_at': {
          const ta = a.createdAt ? Date.parse(a.createdAt) : NaN;
          const tb = b.createdAt ? Date.parse(b.createdAt) : NaN;
          va = Number.isFinite(ta) ? ta : -1;
          vb = Number.isFinite(tb) ? tb : -1;
          break;
        }
        case 'batch':
          va = a.batchName || a.batchId || '';
          vb = b.batchName || b.batchId || '';
          break;
        case 'sheet':
          va = a.hasSheet ? 1 : 0;
          vb = b.hasSheet ? 1 : 0;
          break;
        case 'latest_job':
          va = latestA?.finishedAt || latestA?.requestedAt || latestA?.status || '';
          vb = latestB?.finishedAt || latestB?.requestedAt || latestB?.status || '';
          break;
        case 'actions':
          va = a.batchId ? 1 : 0;
          vb = b.batchId ? 1 : 0;
          break;
        default:
          break;
      }
      if (typeof va === 'number' && typeof vb === 'number') {
        if (va === vb) return 0;
        return va < vb ? -dirMul : dirMul;
      }
      return String(va).localeCompare(String(vb), 'zh', { numeric: true, sensitivity: 'base' }) * dirMul;
    });
  }, [filteredDirs, dirSortKey, dirSortDir, versionSheetJobsByBatch]);

  const dirStats = useMemo(() => {
    const withSheet = filteredDirs.filter((d) => d.hasSheet).length;
    const withBatch = filteredDirs.filter((d) => Boolean(d.batchId)).length;
    return { total: filteredDirs.length, withSheet, withBatch };
  }, [filteredDirs]);

  return (
    <div className="p-4 max-w-[1400px] mx-auto space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-bold text-slate-800 flex items-center gap-2">
            <FileJson className="text-blue-600 shrink-0" size={22} />
            飞书软件包清单
          </h1>
          <p className="mt-0.5 text-xs text-slate-500 truncate">
            Meta JSON + 版本目录 BOM 表（含 meta 下载链接）
          </p>
        </div>
        <label className="flex items-center gap-2 min-w-[200px]">
          <span className="text-xs font-medium text-slate-500 shrink-0">产品</span>
          <select
            className="flex-1 rounded-lg border border-gray-300 px-3 py-1.5 text-sm bg-white"
            value={productId}
            disabled={loadingProducts}
            onChange={(e) => setProductId(e.target.value)}
          >
            {!products.length ? <option value="">暂无产品</option> : null}
            {products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {!p.feishuDriveRootFolderToken ? '（未配置飞书根目录）' : ''}
              </option>
            ))}
          </select>
        </label>
      </div>

      {error ? (
        <div className="flex items-start gap-2 text-sm text-red-700 bg-red-50 border border-red-100 rounded-lg px-3 py-2">
          <AlertCircle size={16} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}
      {info && !error ? (
        <div className="flex items-start gap-2 text-sm text-slate-600 bg-slate-50 border border-slate-100 rounded-lg px-3 py-2">
          <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-emerald-600" />
          <span>{info}</span>
        </div>
      ) : null}

      {/* Meta JSON */}
      <section
        className="relative bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden flex flex-col"
        style={{ height: metaPanelHeight }}
      >
        <div className="px-3 py-2 border-b border-gray-100 flex flex-wrap items-center justify-between gap-2 shrink-0">
          <div className="min-w-0 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <h2 className="text-sm font-semibold text-slate-800 flex items-center gap-1.5">
              <FileJson size={16} className="text-blue-600" />
              Meta 清单（JSON）
            </h2>
            <p className="text-xs text-slate-500">
              <code className="bg-slate-100 px-1 rounded">meta/package-manifest.json</code>
              {exists ? (
                <>
                  {' '}
                  · <span className="font-medium text-slate-700">{entries.length}</span> 条
                  {query.trim() ? (
                    <>
                      {' '}
                      · 筛选 <span className="font-medium text-slate-700">{filteredEntries.length}</span>
                    </>
                  ) : null}
                  {updatedAt ? ` · ${formatTime(updatedAt)}` : ''}
                </>
              ) : (
                ' · 尚未创建'
              )}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input
              className="w-44 sm:w-56 rounded-lg border border-gray-300 px-2.5 py-1.5 text-xs"
              placeholder="筛选文件名 / 路径 / MD5"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <button
              type="button"
              onClick={() => productId && void loadManifest(productId)}
              disabled={!productId || loadingManifest || Boolean(activeJob)}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-lg bg-white border border-gray-300 text-slate-700 hover:bg-gray-50 disabled:opacity-50"
            >
              {loadingManifest ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
              加载
            </button>
            <button
              type="button"
              onClick={() => void handleRefreshScan()}
              disabled={!productId || refreshing || Boolean(activeJob) || !selectedProduct?.feishuDriveRootFolderToken}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 shadow-sm"
            >
              {refreshing || activeJob ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
              {activeJob ? '扫描中…' : '扫描刷新'}
            </button>
          </div>
        </div>

        {activeJob ? (
          <div className="mx-3 mt-2 shrink-0 text-xs text-blue-800 bg-blue-50 border border-blue-100 rounded-lg px-2.5 py-1.5 truncate">
            {BOM_FEISHU_MANIFEST_JOB_STATUS_LABEL[activeJob.status]}
            {activeJob.message ? `：${activeJob.message}` : ''}
          </div>
        ) : null}

        <div className="overflow-auto flex-1 min-h-0 border-t border-gray-100">
          <table className="text-sm table-fixed" style={{ width: metaTableWidth, minWidth: metaTableWidth }}>
            <colgroup>
              {META_COL_KEYS.map((k) => (
                <col key={k} style={{ width: metaColWidths[k] }} />
              ))}
            </colgroup>
            <thead className="bg-slate-50 text-slate-600 text-left sticky top-0 z-10 shadow-sm">
              <tr>
                {META_COL_KEYS.map((k) => {
                  const active = metaSortKey === k;
                  return (
                    <th
                      key={k}
                      className="relative px-3 py-2 font-medium whitespace-nowrap overflow-hidden text-ellipsis select-none"
                      title="点击排序；拖动右缘调列宽"
                    >
                      <button
                        type="button"
                        onClick={() => toggleMetaSort(k)}
                        className="inline-flex items-center gap-1 max-w-[calc(100%-6px)] hover:text-slate-900"
                      >
                        <span className="truncate">{META_COL_LABELS[k]}</span>
                        {active ? (
                          metaSortDir === 'asc' ? (
                            <ArrowUp size={12} className="shrink-0 text-blue-600" />
                          ) : (
                            <ArrowDown size={12} className="shrink-0 text-blue-600" />
                          )
                        ) : (
                          <ChevronsUpDown size={12} className="shrink-0 text-slate-300" />
                        )}
                      </button>
                      <span
                        role="separator"
                        aria-orientation="vertical"
                        aria-label={`调整「${META_COL_LABELS[k]}」列宽`}
                        onMouseDown={(e) => onMetaColResizeStart(k, e)}
                        className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize hover:bg-blue-400/50 active:bg-blue-500/60"
                      />
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {loadingManifest ? (
                <tr>
                  <td colSpan={7} className="px-3 py-8 text-center text-slate-500">
                    <Loader2 className="inline animate-spin mr-2" size={16} />
                    加载清单中…
                  </td>
                </tr>
              ) : sortedEntries.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-3 py-8 text-center text-slate-400">
                    {entries.length === 0 ? '暂无条目，可点击「扫描刷新」' : '无匹配筛选结果'}
                  </td>
                </tr>
              ) : (
                sortedEntries.map((e) => (
                  <tr key={`${e.rel_path}|${e.file_token}`} className="border-t border-gray-100 hover:bg-slate-50/80">
                    <td className="px-3 py-1.5 font-mono text-xs text-slate-700 truncate" title={e.rel_path}>
                      {e.rel_path || '-'}
                    </td>
                    <td className="px-3 py-1.5 text-slate-800 truncate" title={e.file_name}>
                      {e.file_name || '-'}
                    </td>
                    <td className="px-3 py-1.5 font-mono text-xs text-slate-600 truncate" title={e.md5 || undefined}>
                      {e.md5 || <span className="text-amber-600">缺失</span>}
                    </td>
                    <td className="px-3 py-1.5 whitespace-nowrap text-slate-600 truncate">
                      {formatBytes(e.size_bytes)}
                    </td>
                    <td className="px-3 py-1.5 overflow-hidden">
                      {e.download_url ? (
                        <div className="flex items-center gap-1 min-w-0">
                          <a
                            href={e.download_url}
                            target="_blank"
                            rel="noreferrer"
                            className="text-blue-600 hover:underline truncate text-xs min-w-0"
                            title={`${e.download_url}\n（打开飞书文件页，登录后可预览/下载）`}
                          >
                            {e.download_url}
                          </a>
                          <button
                            type="button"
                            className="p-1 text-slate-400 hover:text-slate-700 shrink-0"
                            title="复制链接"
                            onClick={() => void copyText(e.download_url, `url-${e.file_token}`)}
                          >
                            {copiedToken === `url-${e.file_token}` ? (
                              <CheckCircle2 size={14} className="text-emerald-600" />
                            ) : (
                              <ClipboardCopy size={14} />
                            )}
                          </button>
                          <ExternalLink size={12} className="text-slate-300 shrink-0" />
                        </div>
                      ) : (
                        <span
                          className="text-amber-600 text-xs"
                          title="系统设置 → 飞书 →「飞书网页域名」（如 https://xxx.feishu.cn），用于拼文件页链接"
                        >
                          未配置域名
                          <Link to="/settings" className="ml-1 text-blue-600 hover:underline">
                            去设置
                          </Link>
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-1.5 font-mono text-xs text-slate-500 truncate">
                      <button
                        type="button"
                        className="hover:text-slate-800 truncate max-w-full"
                        title={e.file_token}
                        onClick={() => void copyText(e.file_token, `tok-${e.file_token}`)}
                      >
                        {copiedToken === `tok-${e.file_token}` ? '已复制' : `${e.file_token.slice(0, 10)}…`}
                      </button>
                    </td>
                    <td className="px-3 py-1.5 whitespace-nowrap text-slate-500 text-xs truncate">
                      {formatTime(e.uploaded_at)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="px-3 py-1.5 border-t border-gray-100 bg-slate-50/80 shrink-0 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600">
          <span>
            当前列表合计大小{' '}
            <span className="font-semibold text-slate-800">{formatBytes(filteredSizeTotal)}</span>
            {query.trim() ? '（筛选后）' : ''}
            {' · '}
            {filteredEntries.length} 条
          </span>
          {jobs.length > 0 ? (
            <span className="truncate text-[11px] text-slate-500 max-w-[50%]" title={jobs[0]?.message || ''}>
              最近任务：{BOM_FEISHU_MANIFEST_JOB_STATUS_LABEL[jobs[0].status]}
              {jobs[0].message ? ` · ${jobs[0].message}` : ''}
            </span>
          ) : null}
        </div>

        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="拖动调整 Meta 清单高度"
          title="拖动调整高度"
          onMouseDown={onMetaPanelHeightResizeStart}
          className="absolute -bottom-px left-0 right-0 h-4 cursor-row-resize flex items-end justify-center pb-0.5 group z-20"
        >
          <span className="pointer-events-none inline-flex items-center justify-center h-3.5 w-14 rounded-md border border-slate-300 bg-white text-slate-500 shadow-sm group-hover:border-blue-400 group-hover:text-blue-600 group-active:bg-blue-50">
            <GripHorizontal size={16} strokeWidth={2.25} />
          </span>
        </div>
      </section>

      {/* Version dirs BOM sheets */}
      <section
        className="relative bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden flex flex-col"
        style={{ height: dirPanelHeight }}
      >
        <div className="px-3 py-2 border-b border-gray-100 flex flex-wrap items-center justify-between gap-2 shrink-0">
          <div className="min-w-0 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <h2 className="text-sm font-semibold text-slate-800 flex items-center gap-1.5">
              <FolderOpen size={16} className="text-violet-600" />
              版本目录 BOM 表
            </h2>
            <p className="text-xs text-slate-500 truncate">
              「{sheetTitle}」· {dirs.length} 个目录
              {dirQuery.trim() ? (
                <>
                  {' '}
                  · 筛选 <span className="font-medium text-slate-700">{filteredDirs.length}</span>
                </>
              ) : null}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input
              className="w-40 sm:w-52 rounded-lg border border-gray-300 px-2.5 py-1.5 text-xs"
              placeholder="筛选目录 / 批次"
              value={dirQuery}
              onChange={(e) => setDirQuery(e.target.value)}
            />
            <button
              type="button"
              onClick={() => productId && void loadDirs(productId)}
              disabled={!productId || loadingDirs || !selectedProduct?.feishuDriveRootFolderToken}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-lg bg-white border border-gray-300 text-slate-700 hover:bg-gray-50 disabled:opacity-50"
            >
              {loadingDirs ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
              刷新目录
            </button>
          </div>
        </div>

        <div className="overflow-auto flex-1 min-h-0 border-t border-gray-100">
          <table className="text-sm table-fixed" style={{ width: dirTableWidth, minWidth: dirTableWidth }}>
            <colgroup>
              {DIR_COL_KEYS.map((k) => (
                <col key={k} style={{ width: dirColWidths[k] }} />
              ))}
            </colgroup>
            <thead className="bg-slate-50 text-slate-600 text-left sticky top-0 z-10 shadow-sm">
              <tr>
                {DIR_COL_KEYS.map((k) => {
                  const active = dirSortKey === k;
                  return (
                    <th
                      key={k}
                      className="relative px-3 py-2 font-medium whitespace-nowrap overflow-hidden text-ellipsis select-none"
                      title="点击排序；拖动右缘调列宽"
                    >
                      <button
                        type="button"
                        onClick={() => toggleDirSort(k)}
                        className="inline-flex items-center gap-1 max-w-[calc(100%-6px)] hover:text-slate-900"
                      >
                        <span className="truncate">{DIR_COL_LABELS[k]}</span>
                        {active ? (
                          dirSortDir === 'asc' ? (
                            <ArrowUp size={12} className="shrink-0 text-violet-600" />
                          ) : (
                            <ArrowDown size={12} className="shrink-0 text-violet-600" />
                          )
                        ) : (
                          <ChevronsUpDown size={12} className="shrink-0 text-slate-300" />
                        )}
                      </button>
                      <span
                        role="separator"
                        aria-orientation="vertical"
                        aria-label={`调整「${DIR_COL_LABELS[k]}」列宽`}
                        onMouseDown={(e) => onDirColResizeStart(k, e)}
                        className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize hover:bg-violet-400/50 active:bg-violet-500/60"
                      />
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {loadingDirs ? (
                <tr>
                  <td colSpan={6} className="px-3 py-8 text-center text-slate-500">
                    <Loader2 className="inline animate-spin mr-2" size={16} />
                    加载目录中…
                  </td>
                </tr>
              ) : sortedDirs.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-3 py-8 text-center text-slate-400">
                    {dirs.length === 0 ? '暂无一级子目录（或未配置飞书根目录）' : '无匹配筛选结果'}
                  </td>
                </tr>
              ) : (
                sortedDirs.map((d) => {
                  const latest = latestJobForBatch(d.batchId);
                  const busy = Boolean(
                    d.batchId &&
                      (activeVersionSheetBatchIds.has(d.batchId) || generatingBatchId === d.batchId),
                  );
                  return (
                    <tr key={d.folderToken || d.name} className="border-t border-gray-100 hover:bg-slate-50/80">
                      <td className="px-3 py-1.5 font-medium text-slate-800 truncate" title={d.name}>
                        {d.name}
                      </td>
                      <td className="px-3 py-1.5 text-slate-600 text-xs whitespace-nowrap truncate" title={d.createdAt || undefined}>
                        {formatTime(d.createdAt)}
                      </td>
                      <td className="px-3 py-1.5 text-slate-600 text-xs truncate">
                        {d.batchId ? (
                          <span title={d.batchId}>{d.batchName || d.batchId.slice(0, 8)}</span>
                        ) : (
                          <span className="text-amber-600">未匹配批次</span>
                        )}
                      </td>
                      <td className="px-3 py-1.5 overflow-hidden">
                        {d.hasSheet ? (
                          <span
                            className="text-emerald-700 text-xs truncate block"
                            title={d.sheetTitle || d.expectedSheetTitle || undefined}
                          >
                            已有表
                            {d.sheetTitle ? ` · ${d.sheetTitle}` : ''}
                          </span>
                        ) : (
                          <span
                            className="text-slate-400 text-xs truncate block"
                            title={d.expectedSheetTitle || undefined}
                          >
                            尚未生成
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-1.5 text-xs text-slate-500 truncate">
                        {latest ? (
                          <span title={latest.message || ''}>
                            {BOM_FEISHU_VERSION_SHEET_JOB_STATUS_LABEL[latest.status]}
                            {latest.finishedAt || latest.requestedAt
                              ? ` · ${formatTime(latest.finishedAt || latest.requestedAt)}`
                              : ''}
                            {latest.status === 'succeeded' && latest.rowCount
                              ? ` · ${latest.rowCount} 行`
                              : ''}
                          </span>
                        ) : (
                          '-'
                        )}
                      </td>
                      <td className="px-3 py-1.5">
                        <div className="flex flex-wrap items-center gap-1">
                          <button
                            type="button"
                            onClick={() => void handleGenerateVersionSheet(d)}
                            disabled={!d.batchId || busy}
                            className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-lg bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50"
                            title={
                              !d.batchId
                                ? '需有同名 BOM 批次才能生成'
                                : '手动生成/覆盖完整 BOM + meta 下载链接'
                            }
                          >
                            {busy ? <Loader2 size={13} className="animate-spin" /> : <Table2 size={13} />}
                            {busy ? '生成中' : d.hasSheet ? '重新生成' : '生成'}
                          </button>
                          {d.folderUrl ? (
                            <a
                              href={d.folderUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-lg bg-white border border-gray-300 text-slate-700 hover:bg-gray-50"
                              title="在飞书中打开该版本目录"
                            >
                              <FolderOpen size={13} />
                              打开目录
                            </a>
                          ) : (
                            <span
                              className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-lg bg-slate-100 text-slate-400 cursor-not-allowed"
                              title="缺少目录 token"
                            >
                              <FolderOpen size={13} />
                              打开目录
                            </span>
                          )}
                          {d.hasSheet && d.sheetUrl ? (
                            <a
                              href={d.sheetUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-lg bg-white border border-gray-300 text-slate-700 hover:bg-gray-50"
                              title="在飞书中打开 BOM 表"
                            >
                              <Eye size={13} />
                              查看
                            </a>
                          ) : (
                            <span
                              className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-lg bg-slate-100 text-slate-400 cursor-not-allowed"
                              title={!d.hasSheet ? '尚未生成表格' : '缺少表格链接'}
                            >
                              <Eye size={13} />
                              查看
                            </span>
                          )}
                          <button
                            type="button"
                            onClick={() => void handleDeleteVersionSheet(d)}
                            disabled={!d.hasSheet || deletingFolderToken === d.folderToken}
                            className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-lg bg-white border border-red-200 text-red-700 hover:bg-red-50 disabled:opacity-50"
                            title={!d.hasSheet ? '尚未生成表格' : '删除飞书中的该 BOM 表'}
                          >
                            {deletingFolderToken === d.folderToken ? (
                              <Loader2 size={13} className="animate-spin" />
                            ) : (
                              <Trash2 size={13} />
                            )}
                            删除
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        <div className="px-3 py-1.5 border-t border-gray-100 bg-slate-50/80 shrink-0 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600">
          <span>
            当前列表{' '}
            <span className="font-semibold text-slate-800">{dirStats.total}</span> 个目录
            {dirQuery.trim() ? '（筛选后）' : ''}
            {' · 已有表 '}
            <span className="font-semibold text-slate-800">{dirStats.withSheet}</span>
            {' · 已匹配批次 '}
            <span className="font-semibold text-slate-800">{dirStats.withBatch}</span>
          </span>
        </div>

        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="拖动调整版本目录 BOM 表高度"
          title="拖动调整高度"
          onMouseDown={onDirPanelHeightResizeStart}
          className="absolute -bottom-px left-0 right-0 h-4 cursor-row-resize flex items-end justify-center pb-0.5 group z-20"
        >
          <span className="pointer-events-none inline-flex items-center justify-center h-3.5 w-14 rounded-md border border-slate-300 bg-white text-slate-500 shadow-sm group-hover:border-violet-400 group-hover:text-violet-600 group-active:bg-violet-50">
            <GripHorizontal size={16} strokeWidth={2.25} />
          </span>
        </div>
      </section>
    </div>
  );
};
