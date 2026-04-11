import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowDown, ArrowUp, Package, Pencil, Plus, RefreshCcw, Share2, Trash2 } from 'lucide-react';
import { deleteBomBatch, fetchBomBatches, type BomBatch } from '../lib/bomBatches';
import { createProduct, deleteProduct, fetchProducts, moveProduct, type Product, updateProduct } from '../lib/products';

type ProductWithBatches = {
  product: Product;
  batches: BomBatch[];
};

export const BomMaster: React.FC = () => {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [batches, setBatches] = useState<BomBatch[]>([]);
  const [deletingBatchId, setDeletingBatchId] = useState<string | null>(null);
  const [productBusyId, setProductBusyId] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [p, b] = await Promise.all([
        fetchProducts(),
        fetchBomBatches(),
      ]);
      setProducts(p);
      setBatches(b);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleDeleteBatch = async (batch: BomBatch) => {
    const warning = batch.rowCount > 0
      ? `将删除版本「${batch.name}」及其 ${batch.rowCount} 行数据，并级联删除关联下载/同步任务记录。该操作不可恢复。`
      : `将删除空版本「${batch.name}」。该操作不可恢复。`;
    if (!window.confirm(`${warning}\n\n确认删除吗？`)) return;
    setDeletingBatchId(batch.id);
    try {
      await deleteBomBatch(batch.id);
      await load();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setDeletingBatchId(null);
    }
  };

  const handleRenameProduct = async (product: Product) => {
    const next = window.prompt('请输入新的产品名称', product.name);
    if (next == null) return;
    const trimmed = next.trim();
    if (!trimmed) {
      alert('产品名称不能为空');
      return;
    }
    if (trimmed === product.name) return;
    setProductBusyId(product.id);
    try {
      await updateProduct({ id: product.id, name: trimmed });
      await load();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setProductBusyId(null);
    }
  };

  const handleDeleteProduct = async (product: Product, batchCount: number) => {
    if (batchCount > 0) {
      alert(`产品「${product.name}」下仍有 ${batchCount} 个版本，请先删除版本后再删除产品。`);
      return;
    }
    if (!window.confirm(`将删除空产品「${product.name}」，该操作不可恢复。确认继续吗？`)) return;
    setProductBusyId(product.id);
    try {
      await deleteProduct(product.id);
      await load();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/restrict|foreign key|violates/i.test(msg)) {
        alert('删除失败：该产品下仍有关联版本，请先删除版本。');
      } else {
        alert(msg);
      }
    } finally {
      setProductBusyId(null);
    }
  };

  const handleCreateProduct = async () => {
    const next = window.prompt('请输入产品名称');
    if (next == null) return;
    const trimmed = next.trim();
    if (!trimmed) {
      alert('产品名称不能为空');
      return;
    }
    setProductBusyId('__creating__');
    try {
      await createProduct({ name: trimmed });
      await load();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setProductBusyId(null);
    }
  };

  const handleMoveProduct = async (product: Product, direction: 'up' | 'down') => {
    setProductBusyId(product.id);
    try {
      await moveProduct({ productId: product.id, direction });
      await load();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setProductBusyId(null);
    }
  };

  const grouped = useMemo<ProductWithBatches[]>(() => {
    const map = new Map<string, ProductWithBatches>();
    products.forEach((p) => map.set(p.id, { product: p, batches: [] }));
    batches.forEach((b) => {
      const slot = map.get(b.productId);
      if (slot) slot.batches.push(b);
    });
    return Array.from(map.values());
  }, [products, batches]);

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-lg bg-indigo-600 text-white flex items-center justify-center flex-shrink-0">
            <Package size={22} />
          </div>
          <div>
            <h2 className="text-2xl font-bold text-slate-900">BOM 管理</h2>
            <p className="text-slate-500 mt-1">
              产品清单与版本列表。新增或编辑将进入明细页。
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => load()}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-indigo-200 bg-indigo-50 text-indigo-700 hover:bg-indigo-100"
          >
            <RefreshCcw size={16} />
            刷新
          </button>
          <button
            type="button"
            onClick={handleCreateProduct}
            disabled={productBusyId === '__creating__'}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Plus size={16} />
            新增产品
          </button>
        </div>
      </div>

      {error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          加载失败：{error}
        </div>
      ) : null}

      <div className="bg-white rounded-xl border border-gray-200 shadow-sm">
        <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
          <div className="text-sm font-medium text-slate-800">产品与版本</div>
          <div className="text-xs text-slate-500">
            {loading ? '加载中…' : `产品 ${products.length}，版本 ${batches.length}`}
          </div>
        </div>

        <div className="divide-y divide-gray-100">
          {grouped.map(({ product, batches: bs }) => (
            <div key={product.id} className="px-5 py-4">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <div className="text-sm font-semibold text-slate-900">
                    {product.name}
                  </div>
                  <div className="text-xs text-slate-500 mt-0.5">
                    版本数：{bs.length}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => handleMoveProduct(product, 'up')}
                    disabled={productBusyId === product.id || grouped[0]?.product.id === product.id}
                    className="text-xs px-2 py-1.5 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center"
                    title="上移产品"
                  >
                    <ArrowUp size={12} />
                  </button>
                  <button
                    type="button"
                    onClick={() => handleMoveProduct(product, 'down')}
                    disabled={productBusyId === product.id || grouped[grouped.length - 1]?.product.id === product.id}
                    className="text-xs px-2 py-1.5 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center"
                    title="下移产品"
                  >
                    <ArrowDown size={12} />
                  </button>
                  <button
                    type="button"
                    onClick={() => handleRenameProduct(product)}
                    disabled={productBusyId === product.id}
                    className="text-xs px-2.5 py-1.5 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-1"
                    title="重命名产品"
                  >
                    <Pencil size={12} />
                    重命名
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDeleteProduct(product, bs.length)}
                    disabled={productBusyId === product.id}
                    className="text-xs px-2.5 py-1.5 rounded-lg border border-rose-300 text-rose-700 hover:bg-rose-50 disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-1"
                    title={bs.length > 0 ? '请先删除该产品下所有版本' : '删除空产品'}
                  >
                    <Trash2 size={12} />
                    删除产品
                  </button>
                  <button
                    type="button"
                    onClick={() => navigate(`/bom/new?productId=${encodeURIComponent(product.id)}`)}
                    className="text-xs px-3 py-1.5 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50"
                  >
                    在此产品下新建
                  </button>
                </div>
              </div>

              {bs.length > 0 ? (
                <div className="mt-3 overflow-x-auto">
                  <table className="min-w-full text-sm">
                    <thead className="bg-slate-50">
                      <tr>
                        <th className="px-3 py-2 text-left text-xs font-semibold text-slate-700 border-b border-slate-200">版本名称</th>
                        <th className="px-3 py-2 text-left text-xs font-semibold text-slate-700 border-b border-slate-200">行数</th>
                        <th className="px-3 py-2 text-left text-xs font-semibold text-slate-700 border-b border-slate-200">创建时间</th>
                        <th className="px-3 py-2 text-right text-xs font-semibold text-slate-700 border-b border-slate-200">操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {bs
                        .slice()
                        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
                        .map((b) => (
                          <tr key={b.id} className="border-b last:border-b-0">
                            <td className="px-3 py-2 text-slate-900">{b.name}</td>
                            <td className="px-3 py-2 text-slate-700">{b.rowCount}</td>
                            <td className="px-3 py-2 text-slate-600">{new Date(b.createdAt).toLocaleString()}</td>
                            <td className="px-3 py-2">
                              <div className="flex items-center justify-end gap-3 flex-wrap">
                              <button
                                type="button"
                                onClick={() => handleDeleteBatch(b)}
                                disabled={deletingBatchId === b.id}
                                className="inline-flex items-center gap-1 text-rose-700 hover:text-rose-800 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
                                title={b.rowCount > 0 ? '删除版本（会级联删除行与任务记录）' : '删除空版本'}
                              >
                                <Trash2 size={14} />
                                删除
                              </button>
                              <button
                                type="button"
                                onClick={() => navigate(`/bom/${b.id}`)}
                                className="text-indigo-700 hover:text-indigo-800 text-sm font-medium"
                              >
                                查看/编辑
                              </button>
                              <button
                                type="button"
                                onClick={() => navigate(`/bom/${b.id}/distribute`)}
                                className="inline-flex items-center gap-1 text-slate-600 hover:text-slate-900 text-sm font-medium"
                                title="分发：只读清单、本地/ext/飞书状态与拉取等"
                              >
                                <Share2 size={14} />
                                分发
                              </button>
                              </div>
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="mt-3 text-sm text-slate-500">暂无版本。</div>
              )}
            </div>
          ))}

          {!loading && grouped.length === 0 ? (
            <div className="px-5 py-10 text-center text-slate-500">
              暂无产品。请先点击右上角“新增产品”创建。
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
};

