import React, { useState, useEffect } from 'react';
import {
  Save,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Server,
  Key,
  Package,
  Eye,
  EyeOff,
} from 'lucide-react';
import { getAppConfig } from '../lib/appConfig';
import {
  fetchArtifactorySettings,
  saveArtifactorySettings,
  type ArtifactoryConfig,
} from '../lib/artifactorySettings';
import {
  fetchBomScannerSettings,
  mergeWorkerTuning,
  saveBomScannerSettings,
  type BomScannerConfig,
  type BomWorkerTuning,
} from '../lib/bomScannerSettings';
import { useBomWorkerHeartbeat } from '../lib/useBomWorkerHeartbeat';
import {
  fetchLatestBomScanJob,
  fetchLocalFileStats,
  formatSupabaseError,
  requestBomScan,
  type BomScanJob,
  type BomScanJobStatus,
} from '../lib/bomScannerJobs';
import { getArtifactoryApiInfo, type ApiInfoResult } from '../lib/artifactoryApi';

const BOM_SCAN_JOB_STATUS_CN: Record<BomScanJobStatus, string> = {
  queued: '排队中',
  running: '执行中',
  succeeded: '成功',
  failed: '失败',
};

export const Settings: React.FC = () => {
  const [artifactory, setArtifactory] = useState<ArtifactoryConfig>({
    artifactoryBaseUrl: '',
    artifactoryApiKey: '',
    artifactoryExtBaseUrl: '',
    artifactoryExtApiKey: '',
  });
  const [savedArtifactory, setSavedArtifactory] = useState<ArtifactoryConfig | null>(null);
  const [artifactoryLoading, setArtifactoryLoading] = useState(false);
  const [artifactorySaveStatus, setArtifactorySaveStatus] = useState<'idle' | 'success' | 'error'>('idle');

  const [testUrl, setTestUrl] = useState('');
  const [artifactoryTestLoading, setArtifactoryTestLoading] = useState(false);
  const [artifactoryTestResult, setArtifactoryTestResult] = useState<ApiInfoResult | null>(null);

  const [bomScanner, setBomScanner] = useState<BomScannerConfig | null>(null);
  const [bomKeyMapJson, setBomKeyMapJson] = useState('');
  const [bomLoading, setBomLoading] = useState(false);
  const [bomSaveStatus, setBomSaveStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [bomScanJob, setBomScanJob] = useState<BomScanJob | null>(null);
  const [bomScanStats, setBomScanStats] = useState<{ fileCount: number; md5Count: number }>({ fileCount: 0, md5Count: 0 });
  const [bomScanLoading, setBomScanLoading] = useState(false);
  const [bomScanMessage, setBomScanMessage] = useState<string>('');
  const [showWorkerTuning, setShowWorkerTuning] = useState(false);
  const [showMainApiKey, setShowMainApiKey] = useState(false);
  const [showExtApiKey, setShowExtApiKey] = useState(false);
  const bomWorkerHeartbeat = useBomWorkerHeartbeat(bomScanner);

  const patchWorkerTuning = (patch: Partial<BomWorkerTuning>) => {
    setBomScanner((s) =>
      s ? { ...s, workerTuning: mergeWorkerTuning({ ...s.workerTuning, ...patch }) } : s,
    );
  };

  // 与 supabase 客户端一致：优先 window.__APP_CONFIG__，否则 VITE_*
  const { supabaseUrl: envSupabaseUrl } = getAppConfig();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cfg = await fetchArtifactorySettings();
        if (cancelled || !cfg) return;
        setArtifactory(cfg);
        setSavedArtifactory(cfg);
      } catch (e) {
        console.error(e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const artifactoryDirty = (() => {
    const base = savedArtifactory;
    if (!base) return false;
    const norm = (s: string | undefined) => (s ?? '').trim();
    return (
      norm(artifactory.artifactoryBaseUrl) !== norm(base.artifactoryBaseUrl) ||
      norm(artifactory.artifactoryApiKey) !== norm(base.artifactoryApiKey) ||
      norm(artifactory.artifactoryExtBaseUrl) !== norm(base.artifactoryExtBaseUrl) ||
      norm(artifactory.artifactoryExtApiKey) !== norm(base.artifactoryExtApiKey)
    );
  })();

  const loadBomScanRuntime = async () => {
    const [latestJob, stats] = await Promise.all([fetchLatestBomScanJob(), fetchLocalFileStats()]);
    setBomScanJob(latestJob);
    setBomScanStats(stats);
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cfg = await fetchBomScannerSettings();
        if (cancelled) return;
        setBomScanner(cfg);
        setBomKeyMapJson(JSON.stringify(cfg.jsonKeyMap, null, 2));
        await loadBomScanRuntime();
      } catch (e) {
        console.error(e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSaveBomScanner = async () => {
    if (!bomScanner) return;
    let parsed: BomScannerConfig['jsonKeyMap'];
    try {
      const raw = JSON.parse(bomKeyMapJson) as unknown;
      if (!raw || typeof raw !== 'object') throw new Error('jsonKeyMap 必须是 JSON 对象');
      const o = raw as Record<string, unknown>;
      const arr = (k: string) => {
        const v = o[k];
        if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) {
          throw new Error(`jsonKeyMap.${k} 必须是非空字符串数组`);
        }
        return v as string[];
      };
      parsed = {
        downloadUrl: arr('downloadUrl'),
        expectedMd5: arr('expectedMd5'),
        arch: arr('arch'),
        extUrl: o.extUrl !== undefined ? arr('extUrl') : undefined,
        releaseVersion: o.releaseVersion !== undefined ? arr('releaseVersion') : undefined,
        releaseBatch: o.releaseBatch !== undefined ? arr('releaseBatch') : undefined,
        moduleName: o.moduleName !== undefined ? arr('moduleName') : undefined,
        fileSizeBytes: o.fileSizeBytes !== undefined ? arr('fileSizeBytes') : undefined,
        extFileSizeBytes: o.extFileSizeBytes !== undefined ? arr('extFileSizeBytes') : undefined,
        remark: o.remark !== undefined ? arr('remark') : undefined,
      };
    } catch (e) {
      alert(e instanceof Error ? e.message : 'jsonKeyMap JSON 解析失败');
      return;
    }

    try {
      setBomLoading(true);
      await saveBomScannerSettings({
        ...bomScanner,
        jsonKeyMap: parsed,
        extArtifactoryRepo: bomScanner.extArtifactoryRepo?.trim() ?? '',
      });
      const next = await fetchBomScannerSettings();
      setBomScanner(next);
      setBomKeyMapJson(JSON.stringify(next.jsonKeyMap, null, 2));
      setBomSaveStatus('success');
      setTimeout(() => setBomSaveStatus('idle'), 3000);
    } catch (err: any) {
      setBomSaveStatus('error');
      alert('保存 BOM 扫描配置失败: ' + (err.message || '未知错误'));
      setTimeout(() => setBomSaveStatus('idle'), 3000);
    } finally {
      setBomLoading(false);
    }
  };

  const handleTriggerBomScan = async () => {
    try {
      setBomScanLoading(true);
      setBomScanMessage('');
      const jobId = await requestBomScan('manual');
      setBomScanMessage(`已创建扫描任务：${jobId.slice(0, 8)}…（等待 worker 执行）`);
      await loadBomScanRuntime();
    } catch (e) {
      setBomScanMessage(`触发扫描失败：${formatSupabaseError(e)}`);
    } finally {
      setBomScanLoading(false);
    }
  };

  const handleSaveArtifactory = async () => {
    try {
      setArtifactoryLoading(true);
      await saveArtifactorySettings(artifactory);
      setArtifactorySaveStatus('success');
      setSavedArtifactory(artifactory);
      setTimeout(() => setArtifactorySaveStatus('idle'), 3000);
    } catch (err: any) {
      setArtifactorySaveStatus('error');
      alert('保存 Artifactory 配置失败: ' + (err.message || '未知错误'));
      setTimeout(() => setArtifactorySaveStatus('idle'), 3000);
    } finally {
      setArtifactoryLoading(false);
    }
  };

  const handleTestArtifactory = async () => {
    if (artifactoryDirty) {
      alert('请先保存 Artifactory 配置，再点击“测试凭证”。（测试逻辑只读取数据库已保存的配置）');
      return;
    }
    const url = testUrl.trim();
    if (!url) {
      alert('请输入要测试的 Artifactory URL');
      return;
    }

    setArtifactoryTestLoading(true);
    setArtifactoryTestResult(null);
    try {
      const results = await getArtifactoryApiInfo({ urls: [url] });

      const r = results[0];
      if (!r) throw new Error('未返回测试结果');
      setArtifactoryTestResult(r);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setArtifactoryTestResult({ url, ok: false, error: msg });
      alert('测试失败：' + msg);
    } finally {
      setArtifactoryTestLoading(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-slate-900">系统设置</h2>
        <p className="text-slate-500">Artifactory、BOM 扫描与 Worker 等</p>
      </div>

      {/* 系统配置 */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6 space-y-4">
        <div className="flex items-center gap-2">
          <Server size={18} className="text-purple-600" />
          <h3 className="text-lg font-medium text-slate-800">系统配置</h3>
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">
            Supabase URL
            <span className="ml-2 text-xs text-slate-500 font-normal">（自动同步，不可编辑）</span>
          </label>
          <input
            type="text"
            readOnly
            value={envSupabaseUrl || '未配置'}
            className="w-full px-4 py-2 border border-gray-200 rounded-lg bg-slate-50 text-slate-600 font-mono text-sm cursor-not-allowed"
          />
          <p className="text-xs text-slate-500 mt-1">
            来自 <code className="bg-gray-100 px-1 rounded">app-config.js</code>（window.__APP_CONFIG__），生产环境可挂载不同 app-config.js 覆盖
          </p>
        </div>
      </div>

      {/* BOM 本地扫描（阶段 0） */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6 space-y-4">
        <div className="flex items-center gap-2">
          <Package size={18} className="text-indigo-600" />
          <h3 className="text-lg font-medium text-slate-800">BOM 本地扫描</h3>
        </div>
        <p className="text-sm text-slate-500">
          扫描间隔（秒）与 worker 轮询、定时入队一致，由下方配置写入数据库；BOM 行 jsonb 字段别名为多 key 兼容。本地暂存目录由 compose 挂载，不在此配置。
          含 <span className="font-medium text-slate-700">artifactory</span> 的下载链接由{' '}
          <code className="bg-gray-100 px-1 rounded text-xs">bom-scanner-worker</code> 仅从进程环境变量（如{' '}
          <code className="bg-gray-100 px-1 rounded text-xs">IT_ARTIFACTORY_API_KEY</code>
          ）拉取，不读取下表；部署时请与 compose/.env 中密钥保持一致。其它来源仅提示人工拷贝。
        </p>
        {bomScanner && (
          <div className="space-y-4">
            <div className="rounded-lg border border-indigo-100 bg-indigo-50 p-3 text-sm text-indigo-900 space-y-2">
              <div className="text-xs font-medium text-indigo-950">Worker 最近执行（按任务请求时间最新一条）</div>
              {bomScanJob ? (
                <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 text-xs text-indigo-900">
                  <div className="flex justify-between sm:block gap-2">
                    <dt className="text-indigo-800/80 shrink-0">状态</dt>
                    <dd className="font-medium">{BOM_SCAN_JOB_STATUS_CN[bomScanJob.status]}</dd>
                  </div>
                  <div className="flex justify-between sm:block gap-2">
                    <dt className="text-indigo-800/80 shrink-0">触发来源</dt>
                    <dd className="font-mono truncate" title={bomScanJob.triggerSource}>{bomScanJob.triggerSource}</dd>
                  </div>
                  <div className="flex justify-between sm:block gap-2 sm:col-span-2">
                    <dt className="text-indigo-800/80 shrink-0">请求时间</dt>
                    <dd>{new Date(bomScanJob.requestedAt).toLocaleString()}</dd>
                  </div>
                  <div className="flex justify-between sm:block gap-2">
                    <dt className="text-indigo-800/80 shrink-0">开始时间</dt>
                    <dd>{bomScanJob.startedAt ? new Date(bomScanJob.startedAt).toLocaleString() : '—'}</dd>
                  </div>
                  <div className="flex justify-between sm:block gap-2">
                    <dt className="text-indigo-800/80 shrink-0">结束时间</dt>
                    <dd>{bomScanJob.finishedAt ? new Date(bomScanJob.finishedAt).toLocaleString() : '—'}</dd>
                  </div>
                </dl>
              ) : (
                <p className="text-xs text-indigo-800/90">尚无扫描任务记录。若已部署 worker，请确认其能连上 Supabase 且已手动或定时入队。</p>
              )}
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-indigo-800/90 border-t border-indigo-200/60 pt-2">
                <span>索引文件数：{bomScanStats.fileCount}</span>
                <span>已计算 MD5 数：{bomScanStats.md5Count}</span>
              </div>
              <p className="text-xs text-amber-900/90 bg-amber-50/80 border border-amber-200/60 rounded px-2 py-1.5">
                若「结束时间」长期不更新（或一直处于执行中），请检查 <code className="font-mono text-[11px]">bom-scanner</code> 容器/进程是否存活、能否访问数据库与挂载目录。
              </p>
              <div className="flex items-center justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={handleTriggerBomScan}
                  disabled={bomScanLoading}
                  className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md border border-indigo-200 bg-white text-indigo-700 hover:bg-indigo-100 disabled:opacity-60"
                >
                  {bomScanLoading ? <Loader2 size={14} className="animate-spin" /> : null}
                  手动触发扫描
                </button>
                <button
                  type="button"
                  onClick={() => void loadBomScanRuntime()}
                  className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md border border-indigo-200 bg-white text-indigo-700 hover:bg-indigo-100"
                >
                  刷新状态
                </button>
              </div>
              {bomScanJob?.message ? <div className="text-xs text-indigo-800/90">最近结果：{bomScanJob.message}</div> : null}
              {bomScanMessage ? <div className="text-xs text-indigo-800/90">{bomScanMessage}</div> : null}
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">扫描间隔（秒，5–86400）</label>
              <input
                type="number"
                min={5}
                max={86400}
                value={bomScanner.scanIntervalSeconds}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  setBomScanner((s) =>
                    s
                      ? {
                          ...s,
                          scanIntervalSeconds: Number.isFinite(n)
                            ? Math.min(86400, Math.max(5, Math.round(n)))
                            : s.scanIntervalSeconds,
                        }
                      : s
                  );
                }}
                className="w-full max-w-xs px-4 py-2 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
              />
              <p className="text-xs text-slate-500 mt-1">
                与 worker 主循环睡眠、定时自动入队共用同一数值；保存后 worker 下一轮从数据库读取即可生效。
              </p>
              <p className="text-xs text-slate-600 mt-2">
                当前 worker 生效本地目录：
                <code className="bg-gray-100 px-1 rounded ml-1">
                  {bomScanner.workerLocalRoot?.trim() || '（尚未回报）'}
                </code>
              </p>
              {bomWorkerHeartbeat ? (
                <p
                  className={`text-xs mt-1.5 leading-snug ${
                    bomWorkerHeartbeat.level === 'ok_idle'
                      ? 'text-emerald-800'
                      : bomWorkerHeartbeat.level === 'ok_busy'
                        ? 'text-orange-800'
                        : 'text-red-800'
                  }`}
                >
                  <span className="font-medium">Worker 心跳：</span>
                  {bomWorkerHeartbeat.summary}
                </p>
              ) : null}
            </div>

            <div className="rounded-lg border border-slate-200 bg-slate-50/80 p-3 space-y-2">
              <button
                type="button"
                onClick={() => setShowWorkerTuning((v) => !v)}
                className="text-sm font-medium text-slate-800 hover:text-slate-950"
              >
                {showWorkerTuning ? '▼' : '▶'} Worker 队列 / 心跳（毫秒或秒，保存后 worker 下一轮从数据库读取）
              </button>
              {showWorkerTuning && bomScanner ? (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1 text-sm">
                  <label className="block space-y-1">
                    <span className="text-xs text-slate-600">heartbeatMs（心跳 / 进度上报 / 取消轮询间隔，5000–120000）</span>
                    <input
                      type="number"
                      min={5000}
                      max={120000}
                      value={bomScanner.workerTuning.heartbeatMs}
                      onChange={(e) => patchWorkerTuning({ heartbeatMs: Number(e.target.value) })}
                      className="w-full px-3 py-1.5 border border-gray-200 rounded-lg font-mono text-xs"
                    />
                  </label>
                  <label className="block space-y-1">
                    <span className="text-xs text-slate-600">httpTimeoutMs（单次下载/上传 HTTP 超时，≥1000）</span>
                    <input
                      type="number"
                      min={1000}
                      value={bomScanner.workerTuning.httpTimeoutMs}
                      onChange={(e) => patchWorkerTuning({ httpTimeoutMs: Number(e.target.value) })}
                      className="w-full px-3 py-1.5 border border-gray-200 rounded-lg font-mono text-xs"
                    />
                  </label>
                  <label className="block space-y-1">
                    <span className="text-xs text-slate-600">httpRetries（HTTP 失败最大重试次数，0~10）</span>
                    <input
                      type="number"
                      min={0}
                      max={10}
                      value={bomScanner.workerTuning.httpRetries}
                      onChange={(e) => patchWorkerTuning({ httpRetries: Number(e.target.value) })}
                      className="w-full px-3 py-1.5 border border-gray-200 rounded-lg font-mono text-xs"
                    />
                  </label>
                </div>
              ) : null}
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                ext-Artifactory 目标仓库 key（阶段 5）
              </label>
              <input
                type="text"
                value={bomScanner.extArtifactoryRepo}
                onChange={(e) =>
                  setBomScanner((s) => (s ? { ...s, extArtifactoryRepo: e.target.value } : s))
                }
                placeholder="例如 software-bom-bucket"
                className="w-full max-w-md px-4 py-2 border border-gray-200 rounded-lg font-mono text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
              />
              <p className="text-xs text-slate-500 mt-1">
                同步时制品 Deploy/Copy 到此仓库；路径为 <span className="font-mono">产品版本/发布版本/模块/文件名</span>（对应 jsonKeyMap 的 releaseVersion、releaseBatch、moduleName 等列）。
                凭据为扩展实例：环境变量 <span className="font-mono">IT_ARTIFACTORY_EXT_*</span> 或「Artifactory 凭据」中的扩展 Base URL / API Key。
              </p>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">jsonKeyMap（JSON）</label>
              <textarea
                value={bomKeyMapJson}
                onChange={(e) => setBomKeyMapJson(e.target.value)}
                rows={12}
                spellCheck={false}
                className="w-full px-4 py-3 border border-gray-200 rounded-lg font-mono text-xs focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 text-slate-800"
              />
              <p className="text-xs text-slate-500 mt-1">
                键名：<code className="bg-gray-100 px-1 rounded">downloadUrl</code>、
                <code className="bg-gray-100 px-1 rounded">expectedMd5</code>、
                <code className="bg-gray-100 px-1 rounded">arch</code>、
                <code className="bg-gray-100 px-1 rounded">extUrl</code>、
                <code className="bg-gray-100 px-1 rounded">releaseVersion</code>、
                <code className="bg-gray-100 px-1 rounded">releaseBatch</code>、
                <code className="bg-gray-100 px-1 rounded">moduleName</code>、
                <code className="bg-gray-100 px-1 rounded">fileSizeBytes</code>、
                <code className="bg-gray-100 px-1 rounded">extFileSizeBytes</code>、
                <code className="bg-gray-100 px-1 rounded">remark</code>（可选）；值为字符串数组，表示 jsonb 中可能出现的列名。
              </p>
            </div>
            <div className="flex justify-end items-center gap-3 pt-2">
              <button
                type="button"
                onClick={handleSaveBomScanner}
                disabled={bomLoading}
                className="flex items-center gap-2 px-6 py-2 bg-green-600 text-white font-medium rounded-lg hover:bg-green-700 transition-colors shadow-sm focus:outline-none focus:ring-2 focus:ring-green-500/40 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {bomLoading ? <Loader2 size={18} className="animate-spin" /> : <Save size={18} />}
                保存 BOM 扫描配置
              </button>
              {bomSaveStatus === 'success' && (
                <div className="flex items-center gap-1 text-emerald-600 text-sm">
                  <CheckCircle2 size={16} /> 已保存
                </div>
              )}
              {bomSaveStatus === 'error' && (
                <div className="flex items-center gap-1 text-red-600 text-sm">
                  <AlertCircle size={16} /> 保存失败
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Artifactory（MD5 校验等） */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6 space-y-4">
        <div className="flex items-center gap-2">
          <Key size={18} className="text-amber-600" />
          <h3 className="text-lg font-medium text-slate-800">Artifactory 凭证</h3>
        </div>
        <p className="text-sm text-slate-500">
          用于 worker 自动下载、Edge 查询与手工复制下载命令。凭据统一读取数据库 `system_settings.artifactory_config`。
        </p>
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">主实例 Base URL</label>
            <input
              type="url"
              value={artifactory.artifactoryBaseUrl ?? ''}
              onChange={(e) => setArtifactory((a) => ({ ...a, artifactoryBaseUrl: e.target.value }))}
              placeholder="https://artifactory.example.com"
              className="w-full px-4 py-2 border border-gray-200 rounded-lg font-mono text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">主实例 API Key</label>
            <div className="relative">
              <input
                type={showMainApiKey ? 'text' : 'password'}
                value={artifactory.artifactoryApiKey ?? ''}
                onChange={(e) => setArtifactory((a) => ({ ...a, artifactoryApiKey: e.target.value }))}
                placeholder="X-JFrog-Art-Api"
                autoComplete="off"
                className="w-full px-4 py-2 pr-11 border border-gray-200 rounded-lg font-mono text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
              />
              <button
                type="button"
                onClick={() => setShowMainApiKey((v) => !v)}
                aria-label={showMainApiKey ? '隐藏 API Key' : '显示 API Key'}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1.5 rounded-md text-slate-500 hover:text-slate-800 hover:bg-slate-100 transition-colors"
              >
                {showMainApiKey ? <EyeOff size={18} aria-hidden /> : <Eye size={18} aria-hidden />}
              </button>
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">扩展实例 Base URL</label>
            <input
              type="url"
              value={artifactory.artifactoryExtBaseUrl ?? ''}
              onChange={(e) => setArtifactory((a) => ({ ...a, artifactoryExtBaseUrl: e.target.value }))}
              placeholder="https://artifactory-ext.example.com"
              className="w-full px-4 py-2 border border-gray-200 rounded-lg font-mono text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">扩展实例 API Key</label>
            <div className="relative">
              <input
                type={showExtApiKey ? 'text' : 'password'}
                value={artifactory.artifactoryExtApiKey ?? ''}
                onChange={(e) => setArtifactory((a) => ({ ...a, artifactoryExtApiKey: e.target.value }))}
                placeholder="X-JFrog-Art-Api"
                autoComplete="off"
                className="w-full px-4 py-2 pr-11 border border-gray-200 rounded-lg font-mono text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
              />
              <button
                type="button"
                onClick={() => setShowExtApiKey((v) => !v)}
                aria-label={showExtApiKey ? '隐藏 API Key' : '显示 API Key'}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1.5 rounded-md text-slate-500 hover:text-slate-800 hover:bg-slate-100 transition-colors"
              >
                {showExtApiKey ? <EyeOff size={18} aria-hidden /> : <Eye size={18} aria-hidden />}
              </button>
            </div>
          </div>
        </div>
        <p className="text-xs text-slate-500">
          硬约束：前端不会把 API Key 传给 edge；edge 与 worker 运行时均只从数据库读取。
        </p>

        <div className="border-t border-gray-100 pt-4">
          <div className="grid gap-4 md:grid-cols-2 items-end">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                测试 URL（Storage API 鉴权）
              </label>
              <input
                type="url"
                value={testUrl}
                onChange={(e) => setTestUrl(e.target.value)}
                placeholder="https://artifactory.example.com/artifactory/repo/path/file.jar"
                className="w-full px-4 py-2 border border-gray-200 rounded-lg font-mono text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
              />
              <p className="text-xs text-slate-500 mt-1">
                请输入 Artifactory 制品 URL（函数会自动转换为 <code className="bg-slate-100 px-1 rounded text-xs">/artifactory/api/storage</code> 进行验证）。
              </p>
            </div>

            <div className="flex justify-end gap-3 md:justify-end">
              <button
                type="button"
                onClick={handleTestArtifactory}
                disabled={artifactoryTestLoading || artifactoryDirty}
                className="flex items-center gap-2 px-6 py-2 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-700 transition-colors shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {artifactoryTestLoading ? (
                  <Loader2 size={18} className="animate-spin" />
                ) : (
                  <Server size={18} />
                )}
                测试凭证
              </button>
            </div>
          </div>

          {artifactoryTestResult && (
            <div className="mt-3">
              {artifactoryTestResult.ok ? (
                <div className="text-sm text-emerald-700 flex items-center gap-2">
                  <CheckCircle2 size={16} />
                  成功（HTTP {artifactoryTestResult.status ?? '—'}）
                  {artifactoryTestResult.info?.repo ? (
                    <span className="text-slate-600 ml-2">
                      {artifactoryTestResult.info.repo}
                      {artifactoryTestResult.info.path ? `/${artifactoryTestResult.info.path}` : ''}
                    </span>
                  ) : null}
                </div>
              ) : (
                <div className="text-sm text-red-600 flex items-center gap-2">
                  <AlertCircle size={16} />
                  失败（HTTP {artifactoryTestResult.status ?? '—'}）
                  <span className="text-slate-600">
                    {artifactoryTestResult.error || '未知错误'}
                  </span>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex justify-end items-center gap-3 pt-2">
          <button
            type="button"
            onClick={handleSaveArtifactory}
            disabled={artifactoryLoading}
            className="flex items-center gap-2 px-6 py-2 bg-green-600 text-white font-medium rounded-lg hover:bg-green-700 transition-colors shadow-sm focus:outline-none focus:ring-2 focus:ring-green-500/40 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {artifactoryLoading ? <Loader2 size={18} className="animate-spin" /> : <Save size={18} />}
            保存 Artifactory 配置
          </button>
          {artifactorySaveStatus === 'success' && (
            <div className="flex items-center gap-1 text-emerald-600 text-sm">
              <CheckCircle2 size={16} /> 已保存
            </div>
          )}
          {artifactorySaveStatus === 'error' && (
            <div className="flex items-center gap-1 text-red-600 text-sm">
              <AlertCircle size={16} /> 保存失败
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
