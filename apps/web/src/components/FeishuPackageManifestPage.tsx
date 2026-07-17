import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  ClipboardCopy,
  ExternalLink,
  FileJson,
  Loader2,
  RefreshCw,
  Search,
} from 'lucide-react';
import { fetchProducts, type Product } from '../lib/products';
import {
  fetchFeishuPackageManifest,
  requestFeishuPackageManifestRefresh,
  type FeishuPackageManifestEntry,
} from '../lib/feishuPackageManifest';
import {
  BOM_FEISHU_MANIFEST_JOB_STATUS_LABEL,
  fetchBomFeishuManifestJobsForProduct,
  feishuManifestJobIsActive,
  type BomFeishuManifestJob,
} from '../lib/feishuPackageManifestJobs';

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

export const FeishuPackageManifestPage: React.FC = () => {
  const [products, setProducts] = useState<Product[]>([]);
  const [productId, setProductId] = useState('');
  const [loadingProducts, setLoadingProducts] = useState(true);
  const [loadingManifest, setLoadingManifest] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [exists, setExists] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [entries, setEntries] = useState<FeishuPackageManifestEntry[]>([]);
  const [jobs, setJobs] = useState<BomFeishuManifestJob[]>([]);
  const [query, setQuery] = useState('');
  const [copiedToken, setCopiedToken] = useState<string | null>(null);

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

  const activeJob = useMemo(() => jobs.find((j) => feishuManifestJobIsActive(j.status)) ?? null, [jobs]);

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
      setInfo(res.message ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingManifest(false);
    }
  }, []);

  useEffect(() => {
    void loadProducts();
  }, [loadProducts]);

  useEffect(() => {
    if (!productId) return;
    void loadManifest(productId);
    void loadJobs(productId);
  }, [productId, loadManifest, loadJobs]);

  useEffect(() => {
    if (!productId || !activeJob) return;
    const t = window.setInterval(() => {
      void loadJobs(productId);
    }, 2500);
    return () => window.clearInterval(t);
  }, [productId, activeJob, loadJobs]);

  const [prevActiveJobId, setPrevActiveJobId] = useState<string | null>(null);

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

  const copyText = async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedToken(key);
      window.setTimeout(() => setCopiedToken((cur) => (cur === key ? null : cur)), 1500);
    } catch {
      setError('复制失败');
    }
  };

  return (
    <div className="p-6 max-w-[1400px] mx-auto space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-2">
            <FileJson className="text-blue-600" size={26} />
            飞书软件包清单
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            可视化产品根目录下 <code className="text-xs bg-slate-100 px-1 rounded">meta/package-manifest.json</code>
            ，并可扫描云盘刷新去重清单。
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => productId && void loadManifest(productId)}
            disabled={!productId || loadingManifest || Boolean(activeJob)}
            className="inline-flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-lg bg-white border border-gray-300 text-slate-700 hover:bg-gray-50 disabled:opacity-50"
          >
            {loadingManifest ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
            重新加载
          </button>
          <button
            type="button"
            onClick={() => void handleRefreshScan()}
            disabled={!productId || refreshing || Boolean(activeJob) || !selectedProduct?.feishuDriveRootFolderToken}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 shadow-sm"
          >
            {refreshing || activeJob ? <Loader2 size={16} className="animate-spin" /> : <Search size={16} />}
            {activeJob ? '扫描进行中…' : '扫描并刷新清单'}
          </button>
        </div>
      </div>

      <div className="bg-white border border-gray-200 rounded-xl p-4 shadow-sm space-y-4">
        <div className="flex flex-wrap gap-4 items-end">
          <label className="flex flex-col gap-1 min-w-[220px]">
            <span className="text-xs font-medium text-slate-500">产品</span>
            <select
              className="rounded-lg border border-gray-300 px-3 py-2 text-sm bg-white"
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
          <label className="flex flex-col gap-1 flex-1 min-w-[200px]">
            <span className="text-xs font-medium text-slate-500">筛选</span>
            <input
              className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
              placeholder="文件名 / 路径 / MD5 / token"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <div className="text-sm text-slate-500 pb-2">
            {exists ? (
              <span>
                共 <span className="font-semibold text-slate-700">{entries.length}</span> 条
                {updatedAt ? ` · 更新于 ${formatTime(updatedAt)}` : ''}
              </span>
            ) : (
              <span>清单尚未创建</span>
            )}
          </div>
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

        {activeJob ? (
          <div className="text-sm text-blue-800 bg-blue-50 border border-blue-100 rounded-lg px-3 py-2">
            任务 {BOM_FEISHU_MANIFEST_JOB_STATUS_LABEL[activeJob.status]}
            {activeJob.message ? `：${activeJob.message}` : ''}
          </div>
        ) : null}
      </div>

      <div className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-slate-600 text-left">
              <tr>
                <th className="px-4 py-3 font-medium whitespace-nowrap">相对路径</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">文件名</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">MD5</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">大小</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">下载 URL</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">file_token</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">上传时间</th>
              </tr>
            </thead>
            <tbody>
              {loadingManifest ? (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-slate-500">
                    <Loader2 className="inline animate-spin mr-2" size={16} />
                    加载清单中…
                  </td>
                </tr>
              ) : filteredEntries.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-slate-400">
                    {entries.length === 0 ? '暂无条目，可点击「扫描并刷新清单」' : '无匹配筛选结果'}
                  </td>
                </tr>
              ) : (
                filteredEntries.map((e) => (
                  <tr key={`${e.rel_path}|${e.file_token}`} className="border-t border-gray-100 hover:bg-slate-50/80">
                    <td className="px-4 py-3 font-mono text-xs text-slate-700 max-w-[280px] truncate" title={e.rel_path}>
                      {e.rel_path || '-'}
                    </td>
                    <td className="px-4 py-3 text-slate-800 whitespace-nowrap">{e.file_name || '-'}</td>
                    <td className="px-4 py-3 font-mono text-xs text-slate-600 whitespace-nowrap">
                      {e.md5 || <span className="text-amber-600">缺失</span>}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-slate-600">{formatBytes(e.size_bytes)}</td>
                    <td className="px-4 py-3 max-w-[260px]">
                      {e.download_url ? (
                        <div className="flex items-center gap-1">
                          <a
                            href={e.download_url}
                            target="_blank"
                            rel="noreferrer"
                            className="text-blue-600 hover:underline truncate text-xs"
                            title={`${e.download_url}\n（需飞书 access token 才能下载）`}
                          >
                            {e.download_url}
                          </a>
                          <button
                            type="button"
                            className="p-1 text-slate-400 hover:text-slate-700"
                            title="复制 URL"
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
                        '-'
                      )}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-slate-500">
                      <button
                        type="button"
                        className="hover:text-slate-800"
                        title="复制 token"
                        onClick={() => void copyText(e.file_token, `tok-${e.file_token}`)}
                      >
                        {copiedToken === `tok-${e.file_token}` ? '已复制' : `${e.file_token.slice(0, 10)}…`}
                      </button>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-slate-500">{formatTime(e.uploaded_at)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {jobs.length > 0 ? (
        <div className="bg-white border border-gray-200 rounded-xl p-4 shadow-sm">
          <h2 className="text-sm font-semibold text-slate-700 mb-3">最近扫描任务</h2>
          <ul className="space-y-2">
            {jobs.map((j) => (
              <li key={j.id} className="text-sm text-slate-600 flex flex-wrap gap-x-3 gap-y-1 border-b border-gray-50 pb-2 last:border-0">
                <span className="font-medium text-slate-800">{BOM_FEISHU_MANIFEST_JOB_STATUS_LABEL[j.status]}</span>
                <span className="text-slate-400">{formatTime(j.requestedAt)}</span>
                <span className="truncate flex-1 min-w-[200px]">{j.message || '-'}</span>
                {j.status === 'succeeded' ? (
                  <span className="text-xs text-slate-500">
                    文件 {j.filesTotal} · MD5 {j.filesWithMd5}/{j.filesTotal}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
};
