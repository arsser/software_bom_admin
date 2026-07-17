import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, GitCompareArrows, Loader2, RefreshCcw } from 'lucide-react';
import { fetchBomBatches, fetchBomRows, type BomBatch } from '../lib/bomBatches';
import {
  BOM_COMPARE_KIND_LABEL,
  compareBomVersions,
  type BomCompareItem,
  type BomCompareKind,
  type BomCompareResult,
  type BomCompareRowSnapshot,
} from '../lib/bomCompare';
import { defaultBomScannerConfig, fetchBomScannerSettings, type BomScannerConfig } from '../lib/bomScannerSettings';
import { fetchProducts, type Product } from '../lib/products';

type ResultTab = 'diff' | BomCompareKind | 'unaligned';

function displayName(snap: BomCompareRowSnapshot | null): string {
  if (!snap) return '—';
  return snap.fileName || snap.md5.slice(0, 12);
}

function SnapshotBlock({
  label,
  snap,
  highlightKeys,
}: {
  label: string;
  snap: BomCompareRowSnapshot | null;
  highlightKeys?: Set<string>;
}) {
  if (!snap) {
    return (
      <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50/80 px-3 py-2 text-xs text-slate-400">
        {label}：无此行
      </div>
    );
  }
  const hl = (key: string) => (highlightKeys?.has(key) ? 'bg-amber-100 text-amber-950' : '');
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs space-y-1">
      <div className="font-medium text-slate-700">{label}</div>
      <div className={`rounded px-1 ${hl('module')}`}>
        模块：{snap.module || '—'}
      </div>
      <div className={`rounded px-1 ${hl('component')}`}>
        组件：{snap.component || '—'}
      </div>
      <div className={`rounded px-1 ${hl('fileName')}`}>
        文件：{snap.fileName || '—'}
      </div>
      <div className={`rounded px-1 break-all ${hl('downloadUrl')}`}>
        路径：{snap.downloadUrl || '—'}
      </div>
      <div className={`rounded px-1 ${hl('arch')}`}>架构：{snap.arch || '—'}</div>
      <div className={`rounded px-1 ${hl('sizeLabel')}`}>大小：{snap.sizeLabel || '—'}</div>
      <div className="font-mono text-slate-500">MD5：{snap.md5}</div>
    </div>
  );
}

function CompareItemCard({ item, nameA, nameB }: { item: BomCompareItem; nameA: string; nameB: string }) {
  const kindStyle: Record<BomCompareKind, string> = {
    only_a: 'border-red-200 bg-red-50/60',
    only_b: 'border-emerald-200 bg-emerald-50/60',
    changed: 'border-amber-200 bg-amber-50/50',
    same: 'border-slate-200 bg-slate-50/50',
  };
  const badgeStyle: Record<BomCompareKind, string> = {
    only_a: 'bg-red-100 text-red-800',
    only_b: 'bg-emerald-100 text-emerald-800',
    changed: 'bg-amber-100 text-amber-900',
    same: 'bg-slate-200 text-slate-700',
  };
  const hl = new Set(item.fieldDiffs.map((d) => d.key));

  return (
    <div className={`rounded-xl border p-3 space-y-2 ${kindStyle[item.kind]}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${badgeStyle[item.kind]}`}>
          {BOM_COMPARE_KIND_LABEL[item.kind]}
        </span>
        <span className="text-sm font-medium text-slate-800 truncate">
          {displayName(item.a) !== '—' ? displayName(item.a) : displayName(item.b)}
        </span>
        <span className="font-mono text-[11px] text-slate-500 truncate">{item.md5}</span>
      </div>
      {item.kind === 'changed' ? (
        <div className="grid md:grid-cols-2 gap-2">
          <SnapshotBlock label={`A · ${nameA}`} snap={item.a} highlightKeys={hl} />
          <SnapshotBlock label={`B · ${nameB}`} snap={item.b} highlightKeys={hl} />
        </div>
      ) : (
        <SnapshotBlock
          label={item.kind === 'only_a' ? `A · ${nameA}` : item.kind === 'only_b' ? `B · ${nameB}` : '两侧相同'}
          snap={item.a || item.b}
        />
      )}
      {item.fieldDiffs.length > 0 ? (
        <ul className="text-[11px] text-amber-900 space-y-0.5 pl-1">
          {item.fieldDiffs.map((d) => (
            <li key={d.key}>
              {d.label}：「{d.valueA || '空'}」→「{d.valueB || '空'}」
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export const BomComparePage: React.FC = () => {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const [products, setProducts] = useState<Product[]>([]);
  const [batches, setBatches] = useState<BomBatch[]>([]);
  const [config, setConfig] = useState<BomScannerConfig | null>(null);
  const [loadingMeta, setLoadingMeta] = useState(true);
  const [comparing, setComparing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [productId, setProductId] = useState('');
  const [batchIdA, setBatchIdA] = useState('');
  const [batchIdB, setBatchIdB] = useState('');
  const [result, setResult] = useState<BomCompareResult | null>(null);
  const [resultMeta, setResultMeta] = useState<{ nameA: string; nameB: string } | null>(null);
  const [tab, setTab] = useState<ResultTab>('diff');

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

  // 从 URL 初始化选择
  useEffect(() => {
    if (loadingMeta || !batches.length) return;
    const qA = searchParams.get('a')?.trim() || '';
    const qB = searchParams.get('b')?.trim() || '';
    const qP = searchParams.get('productId')?.trim() || '';

    let nextProduct = productId;
    if (qP && products.some((p) => p.id === qP)) {
      nextProduct = qP;
    } else if (qA) {
      const ba = batches.find((x) => x.id === qA);
      if (ba) nextProduct = ba.productId;
    } else if (!nextProduct && products[0]) {
      nextProduct = products[0].id;
    }
    if (nextProduct && nextProduct !== productId) setProductId(nextProduct);

    const inProduct = batches.filter((x) => x.productId === (nextProduct || productId));
    if (qA && inProduct.some((x) => x.id === qA)) setBatchIdA(qA);
    if (qB && inProduct.some((x) => x.id === qB)) setBatchIdB(qB);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadingMeta, batches, products]);

  // 产品切换时校正版本选择
  useEffect(() => {
    if (!productId) return;
    const list = batches.filter((b) => b.productId === productId);
    if (batchIdA && !list.some((b) => b.id === batchIdA)) setBatchIdA('');
    if (batchIdB && !list.some((b) => b.id === batchIdB)) setBatchIdB('');
  }, [productId, batches, batchIdA, batchIdB]);

  const runCompare = async (idA: string, idB: string) => {
    if (!idA || !idB) {
      setError('请选择版本 A 与版本 B');
      return;
    }
    if (idA === idB) {
      setError('请选择两个不同的版本');
      return;
    }
    const ba = batches.find((x) => x.id === idA);
    const bb = batches.find((x) => x.id === idB);
    if (!ba || !bb) {
      setError('版本不存在');
      return;
    }
    if (ba.productId !== bb.productId) {
      setError('只能比较同一产品下的两个版本');
      return;
    }

    setComparing(true);
    setError(null);
    try {
      const [rowsA, rowsB] = await Promise.all([fetchBomRows(idA), fetchBomRows(idB)]);
      const r = compareBomVersions(rowsA, rowsB, keyMap);
      setResult(r);
      setResultMeta({ nameA: ba.name, nameB: bb.name });
      setTab('diff');
      setSearchParams(
        { productId: ba.productId, a: idA, b: idB },
        { replace: true },
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setResult(null);
      setResultMeta(null);
    } finally {
      setComparing(false);
    }
  };

  // URL 带齐 a/b 时自动比较一次
  useEffect(() => {
    if (loadingMeta || comparing || result) return;
    const qA = searchParams.get('a')?.trim() || '';
    const qB = searchParams.get('b')?.trim() || '';
    if (qA && qB && qA !== qB && batchIdA === qA && batchIdB === qB) {
      void runCompare(qA, qB);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadingMeta, batchIdA, batchIdB]);

  const visibleItems: BomCompareItem[] = useMemo(() => {
    if (!result) return [];
    if (tab === 'diff') return [...result.onlyA, ...result.onlyB, ...result.changed];
    if (tab === 'only_a') return result.onlyA;
    if (tab === 'only_b') return result.onlyB;
    if (tab === 'changed') return result.changed;
    if (tab === 'same') return result.same;
    return [];
  }, [result, tab]);

  return (
    <div className="max-w-5xl mx-auto space-y-5 pb-8">
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
            <GitCompareArrows size={22} />
          </div>
          <div className="min-w-0">
            <h2 className="text-2xl font-bold text-slate-900">BOM 版本比较</h2>
            <p className="text-slate-500 mt-1 text-sm">
              按期望 MD5 对齐；比较模块、组件、文件名、下载路径、架构与大小字段。
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void loadMeta()}
          className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-indigo-200 bg-indigo-50 text-indigo-700 hover:bg-indigo-100 text-sm"
        >
          <RefreshCcw size={16} />
          刷新列表
        </button>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4 space-y-4">
        <div className="grid md:grid-cols-3 gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-slate-500">产品</span>
            <select
              className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
              value={productId}
              disabled={loadingMeta}
              onChange={(e) => {
                setProductId(e.target.value);
                setBatchIdA('');
                setBatchIdB('');
                setResult(null);
                setResultMeta(null);
              }}
            >
              {!products.length ? <option value="">暂无产品</option> : null}
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-slate-500">版本 A</span>
            <select
              className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
              value={batchIdA}
              disabled={!productId || loadingMeta}
              onChange={(e) => setBatchIdA(e.target.value)}
            >
              <option value="">请选择</option>
              {productBatches.map((b) => (
                <option key={b.id} value={b.id} disabled={b.id === batchIdB}>
                  {b.name}（{b.rowCount} 行）
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-slate-500">版本 B</span>
            <select
              className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
              value={batchIdB}
              disabled={!productId || loadingMeta}
              onChange={(e) => setBatchIdB(e.target.value)}
            >
              <option value="">请选择</option>
              {productBatches.map((b) => (
                <option key={b.id} value={b.id} disabled={b.id === batchIdA}>
                  {b.name}（{b.rowCount} 行）
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={comparing || !batchIdA || !batchIdB || batchIdA === batchIdB}
            onClick={() => void runCompare(batchIdA, batchIdB)}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-50"
          >
            {comparing ? <Loader2 size={16} className="animate-spin" /> : <GitCompareArrows size={16} />}
            开始比较
          </button>
          {resultMeta ? (
            <span className="text-sm text-slate-600">
              当前结果：<span className="font-medium text-slate-800">{resultMeta.nameA}</span>
              <span className="mx-1 text-slate-400">vs</span>
              <span className="font-medium text-slate-800">{resultMeta.nameB}</span>
            </span>
          ) : null}
        </div>
        {error ? (
          <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
        ) : null}
      </div>

      {result && resultMeta ? (
        <>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
            {(
              [
                { key: 'diff' as const, label: '差异合计', n: result.counts.onlyA + result.counts.onlyB + result.counts.changed, cls: 'border-indigo-200 bg-indigo-50 text-indigo-900' },
                { key: 'only_a' as const, label: '仅 A', n: result.counts.onlyA, cls: 'border-red-200 bg-red-50 text-red-900' },
                { key: 'only_b' as const, label: '仅 B', n: result.counts.onlyB, cls: 'border-emerald-200 bg-emerald-50 text-emerald-900' },
                { key: 'changed' as const, label: '变更', n: result.counts.changed, cls: 'border-amber-200 bg-amber-50 text-amber-950' },
                { key: 'same' as const, label: '相同', n: result.counts.same, cls: 'border-slate-200 bg-slate-50 text-slate-800' },
              ] as const
            ).map((c) => (
              <button
                key={c.key}
                type="button"
                onClick={() => setTab(c.key)}
                className={`rounded-xl border px-3 py-3 text-left transition ring-offset-1 ${
                  tab === c.key ? 'ring-2 ring-indigo-400' : ''
                } ${c.cls}`}
              >
                <div className="text-xs opacity-80">{c.label}</div>
                <div className="text-2xl font-bold tabular-nums">{c.n}</div>
              </button>
            ))}
          </div>

          {(result.counts.unalignedA > 0 || result.counts.unalignedB > 0) && (
            <button
              type="button"
              onClick={() => setTab('unaligned')}
              className={`text-sm rounded-lg border px-3 py-2 ${
                tab === 'unaligned'
                  ? 'border-orange-400 bg-orange-50 text-orange-900'
                  : 'border-orange-200 bg-orange-50/50 text-orange-800'
              }`}
            >
              无法按 MD5 对齐：A {result.counts.unalignedA} 行 · B {result.counts.unalignedB} 行
            </button>
          )}

          <div className="space-y-3">
            {tab === 'unaligned' ? (
              <div className="space-y-4">
                <div>
                  <h3 className="text-sm font-semibold text-slate-700 mb-2">
                    A（{resultMeta.nameA}）缺合法 MD5 · {result.unalignedA.length} 行
                  </h3>
                  <ul className="text-xs text-slate-600 space-y-1 max-h-48 overflow-auto border border-slate-100 rounded-lg p-2 bg-white">
                    {result.unalignedA.length === 0 ? (
                      <li className="text-slate-400">无</li>
                    ) : (
                      result.unalignedA.map((r) => (
                        <li key={r.id} className="font-mono truncate">
                          {r.id.slice(0, 8)}… · {JSON.stringify(r.bom_row).slice(0, 120)}
                        </li>
                      ))
                    )}
                  </ul>
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-slate-700 mb-2">
                    B（{resultMeta.nameB}）缺合法 MD5 · {result.unalignedB.length} 行
                  </h3>
                  <ul className="text-xs text-slate-600 space-y-1 max-h-48 overflow-auto border border-slate-100 rounded-lg p-2 bg-white">
                    {result.unalignedB.length === 0 ? (
                      <li className="text-slate-400">无</li>
                    ) : (
                      result.unalignedB.map((r) => (
                        <li key={r.id} className="font-mono truncate">
                          {r.id.slice(0, 8)}… · {JSON.stringify(r.bom_row).slice(0, 120)}
                        </li>
                      ))
                    )}
                  </ul>
                </div>
              </div>
            ) : visibleItems.length === 0 ? (
              <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 px-4 py-10 text-center text-slate-400 text-sm">
                当前分类无条目
              </div>
            ) : (
              visibleItems.map((item) => (
                <CompareItemCard
                  key={`${item.kind}-${item.md5}`}
                  item={item}
                  nameA={resultMeta.nameA}
                  nameB={resultMeta.nameB}
                />
              ))
            )}
          </div>
        </>
      ) : (
        !comparing && (
          <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 px-4 py-12 text-center text-slate-400 text-sm">
            {loadingMeta ? '加载产品与版本…' : '选择同一产品下的两个版本后点击「开始比较」'}
          </div>
        )
      )}
    </div>
  );
};
