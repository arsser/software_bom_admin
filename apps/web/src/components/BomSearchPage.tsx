import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ExternalLink, Loader2, RefreshCcw, Search } from 'lucide-react';
import { fetchBomBatches, type BomBatch } from '../lib/bomBatches';
import { searchBomRows, type BomSearchHit } from '../lib/bomSearch';
import {
  defaultBomScannerConfig,
  fetchBomScannerSettings,
  type BomScannerConfig,
} from '../lib/bomScannerSettings';
import { fetchProducts, type Product } from '../lib/products';

const PAGE_LIMIT = 100;

export const BomSearchPage: React.FC = () => {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const [products, setProducts] = useState<Product[]>([]);
  const [batches, setBatches] = useState<BomBatch[]>([]);
  const [config, setConfig] = useState<BomScannerConfig | null>(null);
  const [loadingMeta, setLoadingMeta] = useState(true);

  const [productId, setProductId] = useState('');
  const [batchId, setBatchId] = useState(''); // '' = 全部版本
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hits, setHits] = useState<BomSearchHit[] | null>(null);
  const [searchedAt, setSearchedAt] = useState<string | null>(null);

  const keyMap = useMemo(() => (config ?? defaultBomScannerConfig).jsonKeyMap, [config]);

  const productBatches = useMemo(
    () => batches.filter((b) => b.productId === productId),
    [batches, productId],
  );

  const loadMeta = useCallback(async () => {
    setLoadingMeta(true);
    setError(null);
    try {
      const [p, b, scanner] = await Promise.all([
        fetchProducts(),
        fetchBomBatches(),
        fetchBomScannerSettings(),
      ]);
      setProducts(p);
      setBatches(b);
      setConfig(scanner);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingMeta(false);
    }
  }, []);

  useEffect(() => {
    void loadMeta();
  }, [loadMeta]);

  // URL → 表单
  useEffect(() => {
    if (loadingMeta) return;
    const qP = searchParams.get('productId')?.trim() || '';
    const qB = searchParams.get('batchId')?.trim() || '';
    const q = searchParams.get('q')?.trim() || '';

    let nextProduct = productId;
    if (qP && products.some((p) => p.id === qP)) {
      nextProduct = qP;
    } else if (!nextProduct && products[0]) {
      nextProduct = products[0].id;
    }
    if (nextProduct && nextProduct !== productId) setProductId(nextProduct);

    const inProduct = batches.filter((x) => x.productId === (nextProduct || productId));
    if (qB && inProduct.some((x) => x.id === qB)) {
      setBatchId(qB);
    }
    if (q) setQuery(q);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadingMeta, batches, products]);

  useEffect(() => {
    if (!productId) return;
    const list = batches.filter((b) => b.productId === productId);
    if (batchId && !list.some((b) => b.id === batchId)) setBatchId('');
  }, [productId, batches, batchId]);

  const runSearch = async (opts?: { productId?: string; batchId?: string; query?: string }) => {
    const pid = (opts?.productId ?? productId).trim();
    const bid = (opts?.batchId ?? batchId).trim();
    const q = (opts?.query ?? query).trim();

    if (!pid) {
      setError('请选择产品');
      return;
    }
    if (q.length < 2) {
      setError('请输入至少 2 个字符的关键词');
      return;
    }

    setSearching(true);
    setError(null);
    try {
      const rows = await searchBomRows(
        {
          query: q,
          productId: pid,
          batchIds: bid ? [bid] : null,
          limit: PAGE_LIMIT,
          offset: 0,
        },
        keyMap,
      );
      setHits(rows);
      setSearchedAt(new Date().toISOString());
      const next: Record<string, string> = { productId: pid, q };
      if (bid) next.batchId = bid;
      setSearchParams(next, { replace: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setHits(null);
    } finally {
      setSearching(false);
    }
  };

  // URL 带齐 productId + q 时自动搜一次
  useEffect(() => {
    if (loadingMeta || searching || hits) return;
    const qP = searchParams.get('productId')?.trim() || '';
    const q = searchParams.get('q')?.trim() || '';
    const qB = searchParams.get('batchId')?.trim() || '';
    if (qP && q.length >= 2 && productId === qP && query === q && batchId === (qB || '')) {
      void runSearch({ productId: qP, batchId: qB, query: q });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadingMeta, productId, batchId, query]);

  return (
    <div className="max-w-6xl mx-auto space-y-5 pb-8">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3 min-w-0">
          <button
            type="button"
            onClick={() => navigate('/bom')}
            className="mt-1 p-2 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50"
            title="返回 BOM 管理"
          >
            <ArrowLeft size={18} />
          </button>
          <div className="w-10 h-10 rounded-lg bg-indigo-600 text-white flex items-center justify-center flex-shrink-0">
            <Search size={22} />
          </div>
          <div className="min-w-0">
            <h2 className="text-2xl font-bold text-slate-900">BOM 搜索</h2>
            <p className="text-slate-500 mt-1 text-sm">
              在指定产品与版本的 BOM 行中搜索关键词（模块、组件、文件名、MD5、路径等任意字段）。
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void loadMeta()}
          className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-indigo-200 bg-indigo-50 text-indigo-700 hover:bg-indigo-100 text-sm"
        >
          <RefreshCcw size={16} />
          刷新
        </button>
      </div>

      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm space-y-2">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,2fr)_auto] items-end">
          <label className="flex flex-col gap-1 min-w-0">
            <span className="text-xs font-medium text-slate-500">产品</span>
            <select
              value={productId}
              disabled={loadingMeta}
              onChange={(e) => setProductId(e.target.value)}
              className="rounded-lg border border-slate-200 px-3 py-2 text-sm bg-white w-full"
            >
              {!products.length ? <option value="">暂无产品</option> : null}
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 min-w-0">
            <span className="text-xs font-medium text-slate-500">版本（可选）</span>
            <select
              value={batchId}
              disabled={loadingMeta || !productId}
              onChange={(e) => setBatchId(e.target.value)}
              className="rounded-lg border border-slate-200 px-3 py-2 text-sm bg-white w-full"
            >
              <option value="">全部版本</option>
              {productBatches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}（{b.rowCount} 行）
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 min-w-0 sm:col-span-2 lg:col-span-1">
            <span className="text-xs font-medium text-slate-500">关键词</span>
            <input
              type="search"
              value={query}
              disabled={loadingMeta}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void runSearch();
                }
              }}
              placeholder="至少 2 个字符，如文件名、MD5、模块、路径片段…"
              className="rounded-lg border border-slate-200 px-3 py-2 text-sm w-full"
            />
          </label>
          <button
            type="button"
            disabled={loadingMeta || searching || !productId || query.trim().length < 2}
            onClick={() => void runSearch()}
            className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-45 disabled:cursor-not-allowed shrink-0 h-[38px]"
          >
            {searching ? <Loader2 size={16} className="animate-spin" /> : <Search size={16} />}
            搜索
          </button>
        </div>
        {searchedAt ? (
          <p className="text-xs text-slate-400">
            上次搜索 {new Date(searchedAt).toLocaleString()}
            {hits ? ` · 命中 ${hits.length}${hits.length >= PAGE_LIMIT ? '+' : ''} 行` : ''}
          </p>
        ) : null}
      </section>

      {error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </div>
      ) : null}

      {hits ? (
        <section className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-slate-800">搜索结果</h3>
            <span className="text-xs text-slate-500">
              {hits.length === 0
                ? '无匹配行'
                : hits.length >= PAGE_LIMIT
                  ? `显示前 ${PAGE_LIMIT} 条，请缩小范围`
                  : `共 ${hits.length} 条`}
            </span>
          </div>
          {hits.length === 0 ? (
            <p className="px-4 py-8 text-sm text-slate-500 text-center">未找到包含该关键词的 BOM 行</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-50 text-left text-xs text-slate-500">
                  <tr>
                    <th className="px-3 py-2 font-medium whitespace-nowrap">产品 / 版本</th>
                    <th className="px-3 py-2 font-medium whitespace-nowrap">模块</th>
                    <th className="px-3 py-2 font-medium whitespace-nowrap">组件</th>
                    <th className="px-3 py-2 font-medium">文件 / MD5</th>
                    <th className="px-3 py-2 font-medium">链接</th>
                    <th className="px-3 py-2 font-medium whitespace-nowrap">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {hits.map((h) => (
                    <tr key={h.rowId} className="border-t border-slate-100 align-top">
                      <td className="px-3 py-2 whitespace-nowrap">
                        <div className="font-medium text-slate-800">{h.productName}</div>
                        <div className="text-xs text-slate-500">{h.batchName}</div>
                      </td>
                      <td className="px-3 py-2 text-slate-700 max-w-[8rem] truncate" title={h.module}>
                        {h.module || '—'}
                      </td>
                      <td className="px-3 py-2 text-slate-700 max-w-[8rem] truncate" title={h.component}>
                        {h.component || '—'}
                      </td>
                      <td className="px-3 py-2 min-w-[12rem] max-w-xs">
                        <div className="truncate text-slate-800" title={h.fileName}>
                          {h.fileName || '—'}
                        </div>
                        <div className="font-mono text-[11px] text-slate-500 truncate" title={h.md5}>
                          {h.md5 || '—'}
                        </div>
                      </td>
                      <td className="px-3 py-2 min-w-[10rem] max-w-sm space-y-1">
                        {h.downloadUrl ? (
                          <a
                            href={h.downloadUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="flex items-center gap-1 text-xs text-indigo-700 hover:underline truncate"
                            title={h.downloadUrl}
                          >
                            <ExternalLink size={12} className="shrink-0" />
                            下载路径
                          </a>
                        ) : (
                          <span className="text-xs text-slate-400">无下载路径</span>
                        )}
                        {h.extUrl ? (
                          <a
                            href={h.extUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="flex items-center gap-1 text-xs text-emerald-700 hover:underline truncate"
                            title={h.extUrl}
                          >
                            <ExternalLink size={12} className="shrink-0" />
                            Artifactory-ext
                          </a>
                        ) : null}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <Link
                          to={`/bom/${h.batchId}`}
                          className="text-xs font-medium text-indigo-700 hover:underline"
                        >
                          打开版本
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : loadingMeta ? (
        <div className="flex items-center gap-2 text-sm text-slate-500 py-8 justify-center">
          <Loader2 size={16} className="animate-spin" />
          加载产品与版本…
        </div>
      ) : null}
    </div>
  );
};
