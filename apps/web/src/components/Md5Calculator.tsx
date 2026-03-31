import React, { useEffect, useState } from 'react';
import {
  Calculator,
  Link as LinkIcon,
  Key,
  MoreHorizontal,
  Loader2,
} from 'lucide-react';
import { getArtifactoryApiInfo, type ApiInfoResult } from '../lib/artifactoryApi';
import { fetchArtifactorySettings, type ArtifactoryConfig } from '../lib/artifactorySettings';

function copyText(text: string) {
  void navigator.clipboard.writeText(text);
}

export const Md5Calculator: React.FC = () => {
  const [urlsText, setUrlsText] = useState('');
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<ApiInfoResult[]>([]);
  const [config, setConfig] = useState<ArtifactoryConfig | null>(null);
  const [modalRecord, setModalRecord] = useState<ApiInfoResult | null>(null);
  const [expandedUrl, setExpandedUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cfg = await fetchArtifactorySettings();
        if (cancelled) return;
        setConfig(cfg);
      } catch (e) {
        console.error(e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const urls = urlsText
      .split('\n')
      .map((u) => u.trim())
      .filter(Boolean);
    if (urls.length === 0) return;

    setLoading(true);
    setResults([]);
    try {
      const data = await getArtifactoryApiInfo({ urls });
      setResults(data);
    } catch (err) {
      console.error(err);
      alert(err instanceof Error ? err.message : '查询失败');
    } finally {
      setLoading(false);
    }
  };

  const successCount = results.filter((r) => r.ok).length;

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
          <Calculator size={28} className="text-blue-600" />
          MD5 校验工具
        </h2>
        <p className="text-slate-500 mt-1">
          批量通过 Artifactory Storage API 获取制品信息及 MD5，支持直链与标准{' '}
          <code className="text-xs bg-slate-100 px-1 rounded">/artifactory/...</code> 路径。
        </p>
        <p className="text-sm text-slate-400 mt-1">
          凭证由 edge function 从环境变量 IT_ARTIFACTORY_* 读取；系统设置页仅用于展示与手工排查。
        </p>
      </div>

      {config && (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6 space-y-4">
          <div className="flex items-center gap-2 text-slate-800 font-medium">
            <Key size={18} className="text-amber-600" />
            已保存的 Artifactory 配置
          </div>
          <div className="grid gap-4 md:grid-cols-2 text-sm">
            <div className="space-y-1">
              <div className="text-slate-500">主实例 Base URL</div>
              <div className="font-mono text-slate-800 break-all">
                {config.artifactoryBaseUrl || '未配置'}
              </div>
            </div>
            <div className="space-y-1">
              <div className="text-slate-500">扩展实例 Base URL</div>
              <div className="font-mono text-slate-800 break-all">
                {config.artifactoryExtBaseUrl || '未配置'}
              </div>
            </div>
          </div>
        </div>
      )}

      <form onSubmit={handleSubmit} className="bg-white rounded-xl border border-gray-200 shadow-sm p-6 space-y-4">
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">
            制品 URL（每行一个）
          </label>
          <textarea
            required
            rows={6}
            value={urlsText}
            onChange={(e) => setUrlsText(e.target.value)}
            placeholder={
              'https://art.example.com/artifactory/repo/path/file.jar\nhttps://art.example.com/artifactory/repo/path/other.war'
            }
            className="w-full px-4 py-3 border border-gray-200 rounded-lg font-mono text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
          />
          <p className="text-xs text-slate-500 mt-1">可从 Excel/CSV 整列粘贴。</p>
        </div>

        <div className="flex justify-end pt-2">
          <button
            type="submit"
            disabled={loading}
            className="inline-flex items-center gap-2 px-6 py-2.5 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-700 transition-colors shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? <Loader2 size={18} className="animate-spin" /> : <Calculator size={18} />}
            计算 MD5
          </button>
        </div>
      </form>

      {results.length > 0 && (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-100 font-medium text-slate-800">
            结果（{successCount}/{results.length} 成功）
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-slate-500 border-b border-gray-100 bg-slate-50/80">
                  <th className="px-4 py-3 font-medium w-24">状态</th>
                  <th className="px-4 py-3 font-medium min-w-[200px]">URL</th>
                  <th className="px-4 py-3 font-medium">MD5</th>
                  <th className="px-4 py-3 font-medium w-20 text-center">操作</th>
                </tr>
              </thead>
              <tbody>
                {results.map((record) => (
                  <React.Fragment key={record.url}>
                    <tr className="border-b border-gray-50 hover:bg-slate-50/50 align-top">
                      <td className="px-4 py-3">
                        {record.ok ? (
                          <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-emerald-50 text-emerald-700">
                            成功
                          </span>
                        ) : (
                          <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-red-50 text-red-700">
                            失败
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <a
                          href={record.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-blue-600 hover:underline break-all inline-flex items-start gap-1"
                        >
                          <LinkIcon size={14} className="flex-shrink-0 mt-0.5" />
                          {record.url}
                        </a>
                      </td>
                      <td className="px-4 py-3">
                        {record.ok ? (
                          record.info?.checksums?.md5 ? (
                            <div className="flex flex-wrap items-center gap-2">
                              <code className="text-xs bg-slate-100 px-2 py-1 rounded break-all">
                                {record.info.checksums.md5}
                              </code>
                              <button
                                type="button"
                                onClick={() => copyText(record.info!.checksums!.md5)}
                                className="text-xs text-blue-600 hover:underline"
                              >
                                复制
                              </button>
                            </div>
                          ) : (
                            <span className="text-amber-600">响应中无 MD5</span>
                          )
                        ) : (
                          <span className="text-red-600 break-words">{record.error || '请求失败'}</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-center">
                        <button
                          type="button"
                          onClick={() => setModalRecord(record)}
                          className="p-1.5 rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-800"
                          title="原始响应"
                        >
                          <MoreHorizontal size={18} />
                        </button>
                      </td>
                    </tr>
                    {record.ok && record.info && (
                      <tr className="bg-slate-50/30">
                        <td colSpan={4} className="px-4 pb-3 pt-0">
                          <button
                            type="button"
                            onClick={() =>
                              setExpandedUrl((u) => (u === record.url ? null : record.url))
                            }
                            className="text-xs text-slate-500 hover:text-blue-600"
                          >
                            {expandedUrl === record.url ? '收起详情' : '展开详情'}
                          </button>
                          {expandedUrl === record.url && (
                            <dl className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-xs border border-gray-100 rounded-lg p-3 bg-white">
                              <div>
                                <dt className="text-slate-400">Repo</dt>
                                <dd className="font-mono">{record.info.repo ?? '—'}</dd>
                              </div>
                              <div>
                                <dt className="text-slate-400">Path</dt>
                                <dd className="font-mono break-all">{record.info.path ?? '—'}</dd>
                              </div>
                              <div>
                                <dt className="text-slate-400">Size</dt>
                                <dd>{record.info.size != null ? `${record.info.size} bytes` : '—'}</dd>
                              </div>
                              <div>
                                <dt className="text-slate-400">MIME</dt>
                                <dd className="break-all">{record.info.mimeType ?? '—'}</dd>
                              </div>
                              <div className="sm:col-span-2">
                                <dt className="text-slate-400">Download URI</dt>
                                <dd>
                                  {record.info.downloadUri ? (
                                    <a
                                      href={record.info.downloadUri}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="text-blue-600 break-all"
                                    >
                                      {record.info.downloadUri}
                                    </a>
                                  ) : (
                                    '—'
                                  )}
                                </dd>
                              </div>
                              <div className="sm:col-span-2">
                                <dt className="text-slate-400">SHA-1 / SHA-256</dt>
                                <dd className="font-mono text-xs break-all space-y-1">
                                  <div>{record.info.checksums?.sha1 ?? '—'}</div>
                                  <div>{record.info.checksums?.sha256 ?? '—'}</div>
                                </dd>
                              </div>
                            </dl>
                          )}
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {modalRecord && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40"
          role="dialog"
          aria-modal="true"
          onClick={() => setModalRecord(null)}
        >
          <div
            className="bg-white rounded-xl shadow-xl max-w-3xl w-full max-h-[85vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-6 py-4 border-b border-gray-100 flex justify-between items-center">
              <h3 className="font-semibold text-slate-900">API 原始 JSON</h3>
              <button
                type="button"
                onClick={() => setModalRecord(null)}
                className="text-slate-500 hover:text-slate-800 px-2 py-1"
              >
                关闭
              </button>
            </div>
            <pre className="text-xs font-mono p-4 overflow-auto flex-1 bg-slate-50 m-0 rounded-b-xl">
              {JSON.stringify(modalRecord, null, 2)}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
};
