import React, { useEffect, useMemo, useState } from 'react';
import { Globe2, Plus, Trash2, Loader2, AlertCircle, CheckCircle2, X, Zap, Eraser, Edit2, Clock } from 'lucide-react';
import { usePingStore, PingTarget } from '../stores/pingStore';

const formatDate = (ms: number) => new Date(ms).toLocaleString('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false
});

type ModalMode = 'add' | 'edit' | 'delete' | 'reset' | null;

interface ToastState {
  type: 'success' | 'error';
  message: string;
}

export const PingMonitor: React.FC = () => {
  const {
    targets,
    loading,
    error,
    fetchTargets,
    addTarget,
    updateTarget,
    deleteTarget,
    toggleTarget,
    pingNow,
    resetCounts
  } = usePingStore();

  const [modalMode, setModalMode] = useState<ModalMode>(null);
  const [modalTarget, setModalTarget] = useState<PingTarget | null>(null);
  const [domainInput, setDomainInput] = useState('');
  const [labelInput, setLabelInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<ToastState | null>(null);

  useEffect(() => {
    fetchTargets();
  }, [fetchTargets]);

  const openAdd = () => {
    setModalMode('add');
    setModalTarget(null);
    setDomainInput('');
    setLabelInput('');
  };

  const openEdit = (target: PingTarget) => {
    setModalMode('edit');
    setModalTarget(target);
    setDomainInput(target.domain);
    setLabelInput(target.label || '');
  };

  const openDelete = (target: PingTarget) => {
    setModalMode('delete');
    setModalTarget(target);
  };

  const closeModal = () => {
    setModalMode(null);
    setModalTarget(null);
    setDomainInput('');
    setLabelInput('');
  };

  const handleSaveTarget = async () => {
    if (!domainInput.trim()) {
      setToast({ type: 'error', message: '域名不能为空' });
      return;
    }
    setSaving(true);
    try {
      if (modalMode === 'edit' && modalTarget) {
        await updateTarget(modalTarget.id, { domain: domainInput.trim(), label: labelInput.trim() });
      } else {
        await addTarget({ domain: domainInput.trim(), label: labelInput.trim() });
      }
      setToast({ type: 'success', message: '已保存' });
      closeModal();
    } catch (err: any) {
      setToast({ type: 'error', message: err.message || '保存失败' });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!modalTarget) return;
    setSaving(true);
    try {
      await deleteTarget(modalTarget.id);
      setToast({ type: 'success', message: '已删除' });
      closeModal();
    } catch (err: any) {
      setToast({ type: 'error', message: err.message || '删除失败' });
    } finally {
      setSaving(false);
    }
  };

  const confirmReset = (t: PingTarget) => {
    setModalMode('reset');
    setModalTarget(t);
  };

  const handleToggle = async (id: string, enabled: boolean) => {
    try {
      await toggleTarget(id, enabled);
    } catch (err: any) {
      setToast({ type: 'error', message: err.message || '操作失败' });
    }
  };

  const handlePingNow = async (id: string) => {
    setToast(null);
    try {
      const result = await pingNow(id);
      const status = result.success ? '成功' : '失败';
      const detail = result.success
        ? `状态码 ${result.status_code ?? '-'}，延迟 ${result.latency_ms ?? '-'}ms`
        : (result.error || '未知错误');
      setToast({ type: result.success ? 'success' : 'error', message: `${status}：${detail}` });
    } catch (err: any) {
      setToast({ type: 'error', message: err.message || '检测失败' });
    }
  };

  const handleResetCounts = async (id: string) => {
    try {
      await resetCounts(id);
      setToast({ type: 'success', message: '计数已清零' });
    } catch (err: any) {
      setToast({ type: 'error', message: err.message || '操作失败' });
    }
  };

  const successRate = (t: PingTarget) => {
    const total = t.successCount + t.failureCount;
    if (total === 0) return '-';
    return `${Math.round((t.successCount / total) * 100)}%`;
  };

  const avgLatency = (t: PingTarget) => {
    if (t.successCount === 0) return '-';
    return `${Math.round(t.totalLatencyMs / t.successCount)} ms`;
  };

  const modalTitle = useMemo(() => {
    if (modalMode === 'add') return '新增域名';
    if (modalMode === 'edit') return '编辑域名';
    if (modalMode === 'delete') return '删除域名';
    if (modalMode === 'reset') return '清除计数';
    return '';
  }, [modalMode]);

  return (
    <div className="space-y-6">
      {/* 页面标题区域 */}
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-2xl font-bold text-slate-900">域名监测</h2>
          <p className="text-slate-500">管理需要定时检查的域名</p>
        </div>
        <button
          className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg flex items-center gap-2 transition-colors font-medium"
          onClick={openAdd}
        >
          <Plus size={18} /> 新增域名
        </button>
      </div>

      {/* Toast 提示 */}
      {toast && (
        <div className={`flex items-center gap-3 text-sm px-4 py-3 rounded-xl border ${toast.type === 'success' ? 'bg-green-50 text-green-700 border-green-200' : 'bg-red-50 text-red-700 border-red-200'}`}>
          {toast.type === 'success' ? <CheckCircle2 size={18} /> : <AlertCircle size={18} />}
          <span className="flex-1 font-medium">{toast.message}</span>
          <button className="text-xs hover:underline" onClick={() => setToast(null)}>关闭</button>
        </div>
      )}

      {/* 错误提示 */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-start gap-3">
          <AlertCircle className="text-red-600 flex-shrink-0 mt-0.5" size={20} />
          <div className="flex-1">
            <p className="text-red-700 font-medium">加载失败</p>
            <p className="text-red-600 text-sm mt-1">{error}</p>
          </div>
          <button
            onClick={() => fetchTargets()}
            className="px-3 py-1 bg-red-100 hover:bg-red-200 text-red-700 rounded-md text-sm font-medium transition-colors"
          >
            重试
          </button>
        </div>
      )}

      {/* 监测列表 */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        {/* Loading 遮罩 */}
        {loading && targets.length > 0 && (
          <div className="absolute inset-0 bg-white/60 backdrop-blur-sm z-20 flex items-center justify-center">
            <div className="flex flex-col items-center gap-2">
              <div className="w-8 h-8 border-4 border-blue-100 border-t-blue-600 rounded-full animate-spin"></div>
              <p className="text-sm text-slate-600">加载中...</p>
            </div>
          </div>
        )}

        {loading && targets.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64 text-slate-400">
            <div className="w-8 h-8 border-4 border-blue-100 border-t-blue-600 rounded-full animate-spin mb-4"></div>
            <p>正在加载数据...</p>
          </div>
        ) : targets.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64 text-slate-400">
            <Globe2 size={48} className="mb-4 opacity-20" />
            <p>暂无数据，点击"新增域名"开始监测</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse min-w-[900px]">
              <thead className="bg-gray-50 sticky top-0 z-10">
                <tr>
                  <th className="px-4 py-3 text-xs font-medium text-slate-500 uppercase tracking-wider border-b border-gray-100">域名</th>
                  <th className="px-4 py-3 text-xs font-medium text-slate-500 uppercase tracking-wider border-b border-gray-100">备注</th>
                  <th className="px-4 py-3 text-xs font-medium text-slate-500 uppercase tracking-wider border-b border-gray-100 text-center">启用</th>
                  <th className="px-4 py-3 text-xs font-medium text-slate-500 uppercase tracking-wider border-b border-gray-100 text-center">检测次数</th>
                  <th className="px-4 py-3 text-xs font-medium text-slate-500 uppercase tracking-wider border-b border-gray-100 text-center">成功率</th>
                  <th className="px-4 py-3 text-xs font-medium text-slate-500 uppercase tracking-wider border-b border-gray-100 text-center">平均延迟</th>
                  <th className="px-4 py-3 text-xs font-medium text-slate-500 uppercase tracking-wider border-b border-gray-100">首次检测</th>
                  <th className="px-4 py-3 text-xs font-medium text-slate-500 uppercase tracking-wider border-b border-gray-100">最后检测</th>
                  <th className="px-4 py-3 text-xs font-medium text-slate-500 uppercase tracking-wider border-b border-gray-100 text-center">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {targets.map((t) => {
                  const rate = successRate(t);
                  const rateNum = parseInt(rate) || 0;
                  return (
                    <tr key={t.id} className="hover:bg-blue-50/30 transition-colors">
                      <td className="px-4 py-3 text-sm font-medium text-slate-700">
                        <div className="truncate max-w-[200px]" title={t.domain}>
                          {t.domain}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-sm text-slate-600">
                        {t.label || <span className="text-slate-400">-</span>}
                      </td>
                      <td className="px-4 py-3 text-center">
                        <button
                          className={`relative inline-flex h-5 w-10 items-center rounded-full transition ${
                            t.enabled ? 'bg-green-500' : 'bg-gray-300'
                          }`}
                          onClick={() => handleToggle(t.id, !t.enabled)}
                          aria-label={t.enabled ? '关闭监测' : '开启监测'}
                        >
                          <span
                            className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition ${
                              t.enabled ? 'translate-x-5' : 'translate-x-0.5'
                            }`}
                          />
                        </button>
                      </td>
                      <td className="px-4 py-3 text-sm text-slate-600 text-center font-mono">
                        {t.successCount + t.failureCount || <span className="text-slate-400">-</span>}
                      </td>
                      <td className="px-4 py-3 text-center">
                        {rate !== '-' ? (
                          <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                            rateNum >= 95 ? 'bg-green-100 text-green-700' :
                            rateNum >= 80 ? 'bg-yellow-100 text-yellow-700' :
                            'bg-red-100 text-red-700'
                          }`}>
                            {rate}
                          </span>
                        ) : (
                          <span className="text-slate-400 text-sm">-</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-center">
                        {avgLatency(t) !== '-' ? (
                          <span className="text-sm font-mono text-slate-600">{avgLatency(t)}</span>
                        ) : (
                          <span className="text-slate-400 text-sm">-</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-xs text-slate-500 whitespace-nowrap">
                        {t.firstCheckedAt ? (
                          <div className="flex items-center gap-1">
                            <Clock size={12} className="text-slate-400" />
                            {formatDate(t.firstCheckedAt)}
                          </div>
                        ) : (
                          <span className="text-slate-400">-</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-xs text-slate-500 whitespace-nowrap">
                        {t.lastCheckedAt ? (
                          <div className="flex items-center gap-1">
                            <Clock size={12} className="text-slate-400" />
                            {formatDate(t.lastCheckedAt)}
                          </div>
                        ) : (
                          <span className="text-slate-400">-</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-center gap-1">
                          <button
                            className="p-1.5 rounded-md hover:bg-amber-50 text-amber-500 transition-colors"
                            title="立即检测"
                            onClick={() => handlePingNow(t.id)}
                          >
                            <Zap size={16} />
                          </button>
                          <button
                            className="p-1.5 rounded-md hover:bg-slate-100 text-slate-500 transition-colors"
                            title="清除计数"
                            onClick={() => confirmReset(t)}
                          >
                            <Eraser size={16} />
                          </button>
                          <button
                            className="p-1.5 rounded-md hover:bg-blue-50 text-blue-600 transition-colors"
                            title="编辑"
                            onClick={() => openEdit(t)}
                          >
                            <Edit2 size={16} />
                          </button>
                          <button
                            className="p-1.5 rounded-md hover:bg-red-50 text-red-600 transition-colors"
                            title="删除"
                            onClick={() => openDelete(t)}
                          >
                            <Trash2 size={16} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Modal */}
      {modalMode && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-md p-6 space-y-5">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-bold text-slate-900">{modalTitle}</h3>
              <button
                onClick={closeModal}
                className="text-slate-400 hover:text-slate-600 transition-colors p-1 rounded-md hover:bg-slate-100"
              >
                <X size={20} />
              </button>
            </div>
            {modalMode === 'delete' ? (
              <div className="space-y-5">
                <p className="text-sm text-slate-600">
                  确认删除域名 <span className="font-semibold text-slate-900">{modalTarget?.domain}</span> 吗？此操作不可撤销。
                </p>
                <div className="flex justify-end gap-3">
                  <button
                    className="px-4 py-2 border border-gray-200 rounded-lg text-slate-600 hover:bg-gray-50 transition-colors font-medium"
                    onClick={closeModal}
                  >
                    取消
                  </button>
                  <button
                    className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg flex items-center gap-2 transition-colors font-medium disabled:opacity-50"
                    onClick={handleDelete}
                    disabled={saving}
                  >
                    {saving && <Loader2 className="animate-spin" size={16} />} 删除
                  </button>
                </div>
              </div>
            ) : modalMode === 'reset' ? (
              <div className="space-y-5">
                <p className="text-sm text-slate-600">
                  确认清除 <span className="font-semibold text-slate-900">{modalTarget?.domain}</span> 的检测统计数据吗？
                </p>
                <div className="flex justify-end gap-3">
                  <button
                    className="px-4 py-2 border border-gray-200 rounded-lg text-slate-600 hover:bg-gray-50 transition-colors font-medium"
                    onClick={closeModal}
                  >
                    取消
                  </button>
                  <button
                    className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg flex items-center gap-2 transition-colors font-medium disabled:opacity-50"
                    onClick={async () => {
                      setSaving(true);
                      try {
                        if (modalTarget) {
                          await handleResetCounts(modalTarget.id);
                          closeModal();
                        }
                      } finally {
                        setSaving(false);
                      }
                    }}
                    disabled={saving}
                  >
                    {saving && <Loader2 className="animate-spin" size={16} />} 清除
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                <div>
                  <label className="text-sm font-medium text-slate-700 mb-1.5 block">域名</label>
                  <input
                    className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-colors"
                    placeholder="example.com 或 https://example.com"
                    value={domainInput}
                    onChange={(e) => setDomainInput(e.target.value)}
                  />
                </div>
                <div>
                  <label className="text-sm font-medium text-slate-700 mb-1.5 block">备注（可选）</label>
                  <input
                    className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-colors"
                    placeholder="用于标识域名的备注信息"
                    value={labelInput}
                    onChange={(e) => setLabelInput(e.target.value)}
                  />
                </div>
                <div className="flex justify-end gap-3 pt-2">
                  <button
                    className="px-4 py-2 border border-gray-200 rounded-lg text-slate-600 hover:bg-gray-50 transition-colors font-medium"
                    onClick={closeModal}
                  >
                    取消
                  </button>
                  <button
                    className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg flex items-center gap-2 transition-colors font-medium disabled:opacity-50"
                    onClick={handleSaveTarget}
                    disabled={saving}
                  >
                    {saving && <Loader2 className="animate-spin" size={16} />} 保存
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
