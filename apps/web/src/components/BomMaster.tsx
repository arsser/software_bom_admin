import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Package, Plus, RefreshCcw } from 'lucide-react';
import { fetchBomBatches, type BomBatch } from '../lib/bomBatches';
import { fetchProducts, type Product } from '../lib/products';

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

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [p, b] = await Promise.all([fetchProducts(), fetchBomBatches()]);
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

  const grouped = useMemo<ProductWithBatches[]>(() => {
    const map = new Map<string, ProductWithBatches>();
    products.forEach((p) => map.set(p.id, { product: p, batches: [] }));
    batches.forEach((b) => {
      const slot = map.get(b.productId);
      if (slot) slot.batches.push(b);
    });
    return Array.from(map.values()).sort((a, b) => a.product.name.localeCompare(b.product.name));
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
              产品清单与版本（批次）列表。新增或编辑将进入明细页。
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
          <button
            type="button"
            onClick={() => navigate('/bom/new')}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700"
          >
            <Plus size={16} />
            新建批次
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
          <div className="text-sm font-medium text-slate-800">产品与版本（批次）</div>
          <div className="text-xs text-slate-500">
            {loading ? '加载中…' : `产品 ${products.length}，批次 ${batches.length}`}
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
                    批次数：{bs.length}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => navigate(`/bom/new?productId=${encodeURIComponent(product.id)}`)}
                  className="text-xs px-3 py-1.5 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50"
                >
                  在此产品下新建
                </button>
              </div>

              {bs.length > 0 ? (
                <div className="mt-3 overflow-x-auto">
                  <table className="min-w-full text-sm">
                    <thead className="bg-slate-50">
                      <tr>
                        <th className="px-3 py-2 text-left text-xs font-semibold text-slate-700 border-b border-slate-200">版本（批次）</th>
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
                            <td className="px-3 py-2 text-right">
                              <button
                                type="button"
                                onClick={() => navigate(`/bom/${b.id}`)}
                                className="text-indigo-700 hover:text-indigo-800 text-sm font-medium"
                              >
                                查看/编辑
                              </button>
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="mt-3 text-sm text-slate-500">暂无批次。</div>
              )}
            </div>
          ))}

          {!loading && grouped.length === 0 ? (
            <div className="px-5 py-10 text-center text-slate-500">
              暂无产品。请先在明细页通过“快速新增产品/分类”创建一个产品。
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
};

