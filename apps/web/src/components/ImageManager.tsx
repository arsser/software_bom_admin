import React, { useState, useEffect } from 'react';
import { Image as ImageIcon, Plus, Trash2, Loader2, AlertCircle, CheckCircle2, X, Copy, Clock, Pencil } from 'lucide-react';
import { useImageManagerStore, DownloadedImage } from '../stores/imageManagerStore';
import { ImageViewer } from './ImageViewer';

const formatDate = (dateStr: string) => new Date(dateStr).toLocaleString('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false
});

const formatFileSize = (bytes: number | null) => {
  if (!bytes) return '-';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
};

export const ImageManager: React.FC = () => {
  const {
    images,
    loading,
    error,
    total,
    currentPage,
    pageSize,
    fetchImages,
    downloadImage,
    deleteImage,
    updateDescription,
    getPublicUrl
  } = useImageManagerStore();

  const [showAddModal, setShowAddModal] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState<DownloadedImage | null>(null);
  const [showEditModal, setShowEditModal] = useState<DownloadedImage | null>(null);
  const [urlInput, setUrlInput] = useState('');
  const [descriptionInput, setDescriptionInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [viewingImage, setViewingImage] = useState<string | null>(null);
  const [editDescription, setEditDescription] = useState('');

  const totalPages = Math.ceil(total / pageSize);

  useEffect(() => {
    fetchImages();
  }, [fetchImages]);

  const showToast = (type: 'success' | 'error', message: string) => {
    setToast({ type, message });
    setTimeout(() => setToast(null), 3000);
  };

  const handleAddImage = async () => {
    setAddError(null);

    if (!urlInput.trim()) {
      setAddError('请输入图片 URL');
      return;
    }

    // Basic URL validation
    try {
      new URL(urlInput.trim());
    } catch {
      setAddError('请输入有效的 URL');
      return;
    }

    setSaving(true);
    const { data, error: downloadError } = await downloadImage(urlInput.trim());

    if (data) {
      // 如果有描述，更新描述
      if (descriptionInput.trim()) {
        await updateDescription(data.id, descriptionInput.trim());
      }
      setSaving(false);
      showToast('success', '图片下载成功');
      setShowAddModal(false);
      setUrlInput('');
      setDescriptionInput('');
      setAddError(null);
    } else {
      setSaving(false);
      setAddError(downloadError || '图片下载失败');
    }
  };

  const closeAddModal = () => {
    setShowAddModal(false);
    setUrlInput('');
    setDescriptionInput('');
    setAddError(null);
  };

  const handleDelete = async () => {
    if (!showDeleteModal) return;

    setSaving(true);
    const success = await deleteImage(showDeleteModal.id);
    setSaving(false);

    if (success) {
      showToast('success', '图片已删除');
      setShowDeleteModal(null);
    } else {
      showToast('error', '删除失败');
    }
  };

  const handleOpenEditModal = (img: DownloadedImage) => {
    setShowEditModal(img);
    setEditDescription(img.description || '');
  };

  const handleSaveDescription = async () => {
    if (!showEditModal) return;

    setSaving(true);
    const success = await updateDescription(showEditModal.id, editDescription);
    setSaving(false);

    if (success) {
      showToast('success', '描述已更新');
      setShowEditModal(null);
      setEditDescription('');
    } else {
      showToast('error', '保存描述失败');
    }
  };

  const closeEditModal = () => {
    setShowEditModal(null);
    setEditDescription('');
  };

  const handleCopyUrl = async (url: string, id: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch (err) {
      // Fallback for older browsers or non-HTTPS
      const textArea = document.createElement('textarea');
      textArea.value = url;
      textArea.style.position = 'fixed';
      textArea.style.left = '-9999px';
      document.body.appendChild(textArea);
      textArea.select();
      try {
        document.execCommand('copy');
        setCopiedId(id);
        setTimeout(() => setCopiedId(null), 2000);
      } catch {
        showToast('error', '复制失败，请手动复制');
      }
      document.body.removeChild(textArea);
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'completed':
        return <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700">已完成</span>;
      case 'downloading':
        return <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-700">下载中</span>;
      case 'failed':
        return <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700">失败</span>;
      default:
        return <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-700">等待中</span>;
    }
  };

  return (
    <div className="h-[calc(100vh-2rem)] flex flex-col space-y-6">
      {/* Header */}
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-2xl font-bold text-slate-900">图片管理</h2>
          <p className="text-slate-500">下载并管理外部图片资源</p>
        </div>
        <button
          className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg flex items-center gap-2 transition-colors font-medium"
          onClick={() => setShowAddModal(true)}
        >
          <Plus size={18} /> 新增图片
        </button>
      </div>

      {/* Toast */}
      {toast && (
        <div className={`flex items-center gap-3 text-sm px-4 py-3 rounded-xl border ${toast.type === 'success' ? 'bg-green-50 text-green-700 border-green-200' : 'bg-red-50 text-red-700 border-red-200'}`}>
          {toast.type === 'success' ? <CheckCircle2 size={18} /> : <AlertCircle size={18} />}
          <span className="flex-1 font-medium">{toast.message}</span>
          <button className="text-xs hover:underline" onClick={() => setToast(null)}>关闭</button>
        </div>
      )}

      {/* Error - only for list loading errors */}
      {error && !showAddModal && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-start gap-3">
          <AlertCircle className="text-red-600 flex-shrink-0 mt-0.5" size={20} />
          <div className="flex-1">
            <p className="text-red-700 font-medium">加载图片列表失败</p>
            <p className="text-red-600 text-sm mt-1">{error}</p>
          </div>
          <button
            onClick={() => fetchImages()}
            className="px-3 py-1 bg-red-100 hover:bg-red-200 text-red-700 rounded-md text-sm font-medium transition-colors"
          >
            重试
          </button>
        </div>
      )}

      {/* Table */}
      <div className="flex-1 bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden flex flex-col relative">
        {/* Loading overlay */}
        {loading && images.length > 0 && (
          <div className="absolute inset-0 bg-white/60 backdrop-blur-sm z-20 flex items-center justify-center">
            <div className="flex flex-col items-center gap-2">
              <div className="w-8 h-8 border-4 border-blue-100 border-t-blue-600 rounded-full animate-spin"></div>
              <p className="text-sm text-slate-600">加载中...</p>
            </div>
          </div>
        )}

        <div className="overflow-auto flex-1">
          {loading && images.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-slate-400">
              <div className="w-8 h-8 border-4 border-blue-100 border-t-blue-600 rounded-full animate-spin mb-4"></div>
              <p>正在加载...</p>
            </div>
          ) : images.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-slate-400">
              <ImageIcon size={48} className="mb-4 opacity-20" />
              <p>暂无图片，点击"新增图片"开始下载</p>
            </div>
          ) : (
            <table className="w-full text-left border-collapse min-w-[1200px] table-fixed">
              <thead className="bg-gray-50 sticky top-0 z-10">
                <tr>
                  <th className="px-4 py-3 text-xs font-medium text-slate-500 uppercase tracking-wider border-b border-gray-100 w-14 sticky left-0 z-20 bg-gray-50">#</th>
                  <th className="px-4 py-3 text-xs font-medium text-slate-500 uppercase tracking-wider border-b border-gray-100 w-24 sticky left-14 z-10 bg-gray-50">预览</th>
                  <th className="px-4 py-3 text-xs font-medium text-slate-500 uppercase tracking-wider border-b border-gray-100">描述</th>
                  <th className="px-4 py-3 text-xs font-medium text-slate-500 uppercase tracking-wider border-b border-gray-100 w-48">原始 URL</th>
                  <th className="px-4 py-3 text-xs font-medium text-slate-500 uppercase tracking-wider border-b border-gray-100 w-48">内部 URL</th>
                  <th className="px-4 py-3 text-xs font-medium text-slate-500 uppercase tracking-wider border-b border-gray-100 w-20">大小</th>
                  <th className="px-4 py-3 text-xs font-medium text-slate-500 uppercase tracking-wider border-b border-gray-100 w-20">状态</th>
                  <th className="px-4 py-3 text-xs font-medium text-slate-500 uppercase tracking-wider border-b border-gray-100 w-40">创建时间</th>
                  <th className="px-4 py-3 text-xs font-medium text-slate-500 uppercase tracking-wider border-b border-gray-100 w-20 text-center">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {images.map((img, index) => {
                  const publicUrl = img.storage_path ? getPublicUrl(img.storage_path) : '';
                  const startIndex = (currentPage - 1) * pageSize;

                  return (
                    <tr key={img.id} className="hover:bg-blue-50/30 transition-colors">
                      <td className="px-4 py-4 text-xs text-slate-400 font-mono bg-white sticky left-0 z-10">
                        {startIndex + index + 1}
                      </td>
                      <td className="px-4 py-4 bg-white sticky left-14 z-10">
                        {publicUrl ? (
                          <div
                            className="w-16 h-16 rounded-lg border border-gray-200 overflow-hidden cursor-pointer hover:opacity-80 transition-opacity"
                            onClick={() => setViewingImage(publicUrl)}
                          >
                            <img
                              src={publicUrl}
                              alt="预览"
                              className="w-full h-full object-cover"
                              onError={(e) => {
                                (e.target as HTMLImageElement).src = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="%23cbd5e1" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>';
                              }}
                            />
                          </div>
                        ) : (
                          <div className="w-16 h-16 rounded-lg border border-gray-200 bg-gray-100 flex items-center justify-center">
                            <ImageIcon className="text-gray-400" size={24} />
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-4">
                        <span
                          className="text-sm text-slate-600 block whitespace-pre-wrap break-words"
                          style={{ display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}
                          title={img.description || ''}
                        >
                          {img.description || <span className="text-slate-400 italic">-</span>}
                        </span>
                      </td>
                      <td className="px-4 py-4">
                        <div className="flex items-center gap-1">
                          <a
                            href={img.original_url}
                            target="_blank"
                            rel="noreferrer"
                            className="text-sm text-blue-600 hover:text-blue-700 truncate flex-1 min-w-0"
                            title={img.original_url}
                          >
                            {img.original_url}
                          </a>
                          <button
                            onClick={() => handleCopyUrl(img.original_url, img.id)}
                            className="p-1 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded transition-colors flex-shrink-0"
                            title="复制原始 URL"
                          >
                            {copiedId === img.id ? (
                              <span className="text-xs text-green-600">✓</span>
                            ) : (
                              <Copy size={14} />
                            )}
                          </button>
                        </div>
                      </td>
                      <td className="px-4 py-4">
                        {publicUrl ? (
                          <div className="flex items-center gap-1">
                            <a
                              href={publicUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="text-sm text-green-600 hover:text-green-700 truncate flex-1 min-w-0"
                              title={publicUrl}
                            >
                              {publicUrl}
                            </a>
                            <button
                              onClick={() => handleCopyUrl(publicUrl, `${img.id}-storage`)}
                              className="p-1 text-slate-400 hover:text-green-600 hover:bg-green-50 rounded transition-colors flex-shrink-0"
                              title="复制内部 URL"
                            >
                              {copiedId === `${img.id}-storage` ? (
                                <span className="text-xs text-green-600">✓</span>
                              ) : (
                                <Copy size={14} />
                              )}
                            </button>
                          </div>
                        ) : (
                          <span className="text-sm text-slate-400">-</span>
                        )}
                      </td>
                      <td className="px-4 py-4 text-sm text-slate-600 font-mono">
                        {formatFileSize(img.file_size)}
                      </td>
                      <td className="px-4 py-4">
                        {getStatusBadge(img.status)}
                        {img.error_message && (
                          <p className="text-xs text-red-500 mt-1 truncate max-w-[100px]" title={img.error_message}>
                            {img.error_message}
                          </p>
                        )}
                      </td>
                      <td className="px-4 py-4 text-xs text-slate-500 whitespace-nowrap">
                        <div className="flex items-center gap-1">
                          <Clock size={12} className="text-slate-400" />
                          {formatDate(img.created_at)}
                        </div>
                      </td>
                      <td className="px-4 py-4">
                        <div className="flex items-center justify-center gap-1">
                          <button
                            className="p-1.5 rounded-md hover:bg-blue-50 text-blue-600 transition-colors"
                            title="编辑描述"
                            onClick={() => handleOpenEditModal(img)}
                          >
                            <Pencil size={16} />
                          </button>
                          <button
                            className="p-1.5 rounded-md hover:bg-red-50 text-red-600 transition-colors"
                            title="删除"
                            onClick={() => setShowDeleteModal(img)}
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
          )}
        </div>

        {/* Pagination */}
        <div className="flex items-center justify-between p-4 border-t border-gray-100 bg-gray-50">
          <div className="flex items-center gap-2">
            <span className="text-sm text-slate-500">
              共 {total} 张图片
            </span>
          </div>
          <div className="flex items-center gap-4">
            <span className="text-sm text-slate-500">
              第 {currentPage} 页 / 共 {Math.max(1, totalPages)} 页
            </span>
            <div className="flex gap-1">
              <button
                onClick={() => fetchImages(currentPage - 1, pageSize)}
                disabled={currentPage === 1}
                className="px-3 py-1 border border-gray-200 rounded-md bg-white text-slate-600 disabled:opacity-50 hover:bg-gray-50 text-sm"
              >
                上一页
              </button>
              <button
                onClick={() => fetchImages(currentPage + 1, pageSize)}
                disabled={currentPage >= totalPages}
                className="px-3 py-1 border border-gray-200 rounded-md bg-white text-slate-600 disabled:opacity-50 hover:bg-gray-50 text-sm"
              >
                下一页
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Add Modal */}
      {showAddModal && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg p-6 space-y-5">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-bold text-slate-900">新增图片</h3>
              <button
                onClick={closeAddModal}
                className="text-slate-400 hover:text-slate-600 transition-colors p-1 rounded-md hover:bg-slate-100"
              >
                <X size={20} />
              </button>
            </div>

            {/* Error display in modal */}
            {addError && (
              <div className="flex items-start gap-3 p-3 bg-red-50 border border-red-200 rounded-lg">
                <AlertCircle className="text-red-600 flex-shrink-0 mt-0.5" size={18} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-red-700 break-words">{addError}</p>
                </div>
                <button
                  onClick={() => setAddError(null)}
                  className="text-red-400 hover:text-red-600 flex-shrink-0"
                >
                  <X size={16} />
                </button>
              </div>
            )}

            <div>
              <label className="text-sm font-medium text-slate-700 mb-1.5 block">图片 URL</label>
              <input
                type="url"
                className={`w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 transition-colors ${
                  addError ? 'border-red-300 focus:ring-red-500/20 focus:border-red-500' : 'border-gray-200 focus:ring-blue-500/20 focus:border-blue-500'
                }`}
                placeholder="https://example.com/image.jpg"
                value={urlInput}
                onChange={(e) => { setUrlInput(e.target.value); setAddError(null); }}
                onKeyDown={(e) => e.key === 'Enter' && !saving && handleAddImage()}
                disabled={saving}
              />
              <p className="text-xs text-slate-500 mt-1.5">
                输入图片的完整 URL，系统将通过服务端下载并保存到 Storage
              </p>
            </div>
            <div>
              <label className="text-sm font-medium text-slate-700 mb-1.5 block">描述 <span className="text-slate-400 font-normal">(可选)</span></label>
              <input
                type="text"
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-colors"
                placeholder="输入图片描述..."
                value={descriptionInput}
                onChange={(e) => setDescriptionInput(e.target.value)}
                disabled={saving}
              />
            </div>
            <div className="flex justify-end gap-3 pt-2">
              <button
                className="px-4 py-2 border border-gray-200 rounded-lg text-slate-600 hover:bg-gray-50 transition-colors font-medium disabled:opacity-50"
                onClick={closeAddModal}
                disabled={saving}
              >
                取消
              </button>
              <button
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg flex items-center gap-2 transition-colors font-medium disabled:opacity-50"
                onClick={handleAddImage}
                disabled={saving}
              >
                {saving && <Loader2 className="animate-spin" size={16} />}
                {saving ? '下载中...' : '下载并保存'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Modal */}
      {showDeleteModal && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-md p-6 space-y-5">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-bold text-slate-900">确认删除</h3>
              <button
                onClick={() => setShowDeleteModal(null)}
                className="text-slate-400 hover:text-slate-600 transition-colors p-1 rounded-md hover:bg-slate-100"
              >
                <X size={20} />
              </button>
            </div>
            <p className="text-sm text-slate-600">
              确认删除此图片吗？图片文件和记录都将被删除，此操作不可撤销。
            </p>
            <div className="flex justify-end gap-3">
              <button
                className="px-4 py-2 border border-gray-200 rounded-lg text-slate-600 hover:bg-gray-50 transition-colors font-medium"
                onClick={() => setShowDeleteModal(null)}
              >
                取消
              </button>
              <button
                className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg flex items-center gap-2 transition-colors font-medium disabled:opacity-50"
                onClick={handleDelete}
                disabled={saving}
              >
                {saving && <Loader2 className="animate-spin" size={16} />}
                删除
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Description Modal */}
      {showEditModal && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg p-6 space-y-5">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-bold text-slate-900">编辑描述</h3>
              <button
                onClick={closeEditModal}
                className="text-slate-400 hover:text-slate-600 transition-colors p-1 rounded-md hover:bg-slate-100"
              >
                <X size={20} />
              </button>
            </div>

            {/* Preview */}
            <div className="flex items-center gap-4 p-3 bg-slate-50 rounded-lg">
              {showEditModal.storage_path ? (
                <img
                  src={getPublicUrl(showEditModal.storage_path)}
                  alt="预览"
                  className="w-16 h-16 object-cover rounded-lg border border-gray-200"
                />
              ) : (
                <div className="w-16 h-16 rounded-lg border border-gray-200 bg-gray-100 flex items-center justify-center">
                  <ImageIcon className="text-gray-400" size={24} />
                </div>
              )}
              <div className="flex-1 min-w-0">
                <p className="text-sm text-slate-600 truncate" title={showEditModal.original_url}>
                  {showEditModal.original_url}
                </p>
                <p className="text-xs text-slate-400 mt-1">
                  {formatFileSize(showEditModal.file_size)} · {formatDate(showEditModal.created_at)}
                </p>
              </div>
            </div>

            <div>
              <label className="text-sm font-medium text-slate-700 mb-1.5 block">描述</label>
              <textarea
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-colors resize-none"
                placeholder="输入图片描述..."
                rows={3}
                value={editDescription}
                onChange={(e) => setEditDescription(e.target.value)}
                disabled={saving}
                autoFocus
              />
            </div>

            <div className="flex justify-end gap-3">
              <button
                className="px-4 py-2 border border-gray-200 rounded-lg text-slate-600 hover:bg-gray-50 transition-colors font-medium disabled:opacity-50"
                onClick={closeEditModal}
                disabled={saving}
              >
                取消
              </button>
              <button
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg flex items-center gap-2 transition-colors font-medium disabled:opacity-50"
                onClick={handleSaveDescription}
                disabled={saving}
              >
                {saving && <Loader2 className="animate-spin" size={16} />}
                保存
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Image Viewer */}
      <ImageViewer imageUrl={viewingImage} onClose={() => setViewingImage(null)} />
    </div>
  );
};
