import React, { useState, useEffect } from 'react';
import { Save, Clock, Loader2, CheckCircle2, AlertCircle, Server, Key, Package } from 'lucide-react';
import { usePingStore } from '../stores/pingStore';
import { getAppConfig } from '../lib/appConfig';
import {
  fetchArtifactorySettings,
  saveArtifactorySettings,
  type ArtifactoryConfig,
} from '../lib/artifactorySettings';
import {
  fetchBomScannerSettings,
  saveBomScannerSettings,
  type BomScannerConfig,
} from '../lib/bomScannerSettings';
import {
  fetchLatestBomScanJob,
  fetchLocalFileStats,
  formatSupabaseError,
  requestBomScan,
  type BomScanJob,
  type BomScanJobStatus,
} from '../lib/bomScannerJobs';
import { getArtifactoryApiInfo, type ApiInfoResult } from '../lib/artifactoryApi';

// 验证 Cron 表达式格式
const validateCronExpression = (cron: string): { valid: boolean; error?: string } => {
  const trimmed = cron.trim();
  if (!trimmed) {
    return { valid: false, error: 'Cron 表达式不能为空' };
  }

  // Cron 表达式应该是 5 个字段，用空格分隔：分钟 小时 日 月 星期
  const parts = trimmed.split(/\s+/);
  if (parts.length !== 5) {
    return {
      valid: false,
      error: `Cron 表达式格式错误：应为 5 个字段（分钟 小时 日 月 星期），用空格分隔。例如：*/5 * * * *`
    };
  }

  // 基本格式检查：每个字段应该是数字、*、*/数字、范围或列表
  const cronPattern = /^(\*|\*\/\d+|\d+(-\d+)?(,\d+(-\d+)?)*|\?)$/;
  for (let i = 0; i < parts.length; i++) {
    if (!cronPattern.test(parts[i])) {
      return {
        valid: false,
        error: `Cron 表达式第 ${i + 1} 个字段格式错误：${parts[i]}`
      };
    }
  }

  return { valid: true };
};

const BOM_SCAN_JOB_STATUS_CN: Record<BomScanJobStatus, string> = {
  queued: '排队中',
  running: '执行中',
  succeeded: '成功',
  failed: '失败',
};

export const Settings: React.FC = () => {
  const {
    settings: pingSettings,
    fetchSettings: fetchPingSettings,
    saveSettings: savePingSettings
  } = usePingStore();

  const [pingSaveStatus, setPingSaveStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [loading, setLoading] = useState(false);

  const [artifactory, setArtifactory] = useState<ArtifactoryConfig>({
    artifactoryBaseUrl: '',
    artifactoryApiKey: '',
    artifactoryExtBaseUrl: '',
    artifactoryExtApiKey: '',
  });
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

  // 与 supabase 客户端一致：优先 window.__APP_CONFIG__，否则 VITE_*
  const { supabaseUrl: envSupabaseUrl } = getAppConfig();

  type PingIntervalOption = '5m' | '15m' | '1h' | '24h' | 'custom';
  const [pingInterval, setPingInterval] = useState<PingIntervalOption>('5m');
  const [pingCustomCron, setPingCustomCron] = useState('');
  const [pingEnabled, setPingEnabled] = useState(true);
  const [pingTimeoutMs, setPingTimeoutMs] = useState(5000);
  const [pingMaxLatencyMs, setPingMaxLatencyMs] = useState(1500);
  const [pingMaxTargets, setPingMaxTargets] = useState(50);
  const pingCronValidation = pingCustomCron ? validateCronExpression(pingCustomCron) : { valid: true };
  const presetPingCron: Record<Exclude<PingIntervalOption, 'custom'>, string> = {
    '5m': '*/5 * * * *',
    '15m': '*/15 * * * *',
    '1h': '0 * * * *',
    '24h': '0 0 * * *'
  };

  useEffect(() => {
    fetchPingSettings();
  }, [fetchPingSettings]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cfg = await fetchArtifactorySettings();
        if (cancelled || !cfg) return;
        setArtifactory(cfg);
      } catch (e) {
        console.error(e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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

  useEffect(() => {
    if (pingSettings) {
      const matched = Object.entries(presetPingCron).find(
        ([, cron]) => cron === pingSettings.cronExpression
      )?.[0] as PingIntervalOption | undefined;
      if (matched) {
        setPingInterval(matched);
        setPingCustomCron('');
      } else {
        setPingInterval('custom');
        setPingCustomCron(pingSettings.cronExpression);
      }
      setPingEnabled(pingSettings.enabled);
      setPingTimeoutMs(pingSettings.timeoutMs);
      setPingMaxLatencyMs(pingSettings.maxLatencyMs);
      setPingMaxTargets(pingSettings.maxTargetsPerRun);
    }
  }, [pingSettings]);

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
        fileSizeBytes: o.fileSizeBytes !== undefined ? arr('fileSizeBytes') : undefined,
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
      setTimeout(() => setArtifactorySaveStatus('idle'), 3000);
    } catch (err: any) {
      setArtifactorySaveStatus('error');
      alert('保存 Artifactory 配置失败: ' + (err.message || '未知错误'));
      setTimeout(() => setArtifactorySaveStatus('idle'), 3000);
    } finally {
      setArtifactoryLoading(false);
    }
  };

  const handleSavePingSettings = async () => {
    try {
      setLoading(true);
      const cronValue =
        pingInterval === 'custom'
          ? pingCustomCron.trim()
          : presetPingCron[pingInterval];

      if (pingInterval === 'custom') {
        if (!pingCustomCron.trim()) {
          alert('请填写自定义 Cron 表达式');
          return;
        }
        const validation = validateCronExpression(pingCustomCron);
        if (!validation.valid) {
          alert(`Cron 表达式格式错误：${validation.error}`);
          return;
        }
      }

      await savePingSettings({
        enabled: pingEnabled,
        cronExpression: cronValue,
        timeoutMs: pingTimeoutMs,
        maxLatencyMs: pingMaxLatencyMs,
        maxTargetsPerRun: pingMaxTargets
      });
      setPingSaveStatus('success');
      setTimeout(() => setPingSaveStatus('idle'), 3000);
    } catch (err: any) {
      setPingSaveStatus('error');
      alert('保存监测设置失败: ' + (err.message || '未知错误'));
      setTimeout(() => setPingSaveStatus('idle'), 3000);
    } finally {
      setLoading(false);
    }
  };

  const handleTestArtifactory = async () => {
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
        <p className="text-slate-500">配置域名监测参数</p>
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
                <code className="bg-gray-100 px-1 rounded">fileSizeBytes</code>、
                <code className="bg-gray-100 px-1 rounded">remark</code>（可选）；值为字符串数组，表示 jsonb 中可能出现的列名。
              </p>
            </div>
            <div className="flex justify-end items-center gap-3 pt-2">
              <button
                type="button"
                onClick={handleSaveBomScanner}
                disabled={bomLoading}
                className="flex items-center gap-2 px-6 py-2 bg-indigo-600 text-white font-medium rounded-lg hover:bg-indigo-700 transition-colors shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
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
            <input
              type="password"
              value={artifactory.artifactoryApiKey ?? ''}
              onChange={(e) => setArtifactory((a) => ({ ...a, artifactoryApiKey: e.target.value }))}
              placeholder="X-JFrog-Art-Api"
              autoComplete="off"
              className="w-full px-4 py-2 border border-gray-200 rounded-lg font-mono text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
            />
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
            <input
              type="password"
              value={artifactory.artifactoryExtApiKey ?? ''}
              onChange={(e) => setArtifactory((a) => ({ ...a, artifactoryExtApiKey: e.target.value }))}
              placeholder="X-JFrog-Art-Api"
              autoComplete="off"
              className="w-full px-4 py-2 border border-gray-200 rounded-lg font-mono text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
            />
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
                disabled={artifactoryTestLoading}
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
            className="flex items-center gap-2 px-6 py-2 bg-green-600 text-white font-medium rounded-lg hover:bg-green-700 transition-colors shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
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

      {/* 域名监测设置 */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6 space-y-4">
        <div className="flex items-center gap-2">
          <Clock size={18} className="text-blue-600" />
          <h3 className="text-lg font-medium text-slate-800">域名监测</h3>
        </div>
        <p className="text-sm text-slate-500">
          配置定时检测域名的频率与阈值，任务名 <code className="bg-gray-100 px-1 rounded text-xs">ping-domains</code>。
        </p>

        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                启用域名监测
              </label>
              <p className="text-xs text-slate-500">
                自动定期检测域名连通性和延迟
              </p>
            </div>
            <input
              type="checkbox"
              checked={pingEnabled}
              onChange={(e) => setPingEnabled(e.target.checked)}
              className="w-5 h-5 text-blue-600 rounded focus:ring-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
            />
          </div>

          {pingEnabled && (
            <>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">
                    检测周期
                  </label>
                  <div className="relative">
                    <Clock className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
                    <select
                      value={pingInterval}
                      onChange={(e) => {
                        const value = e.target.value as PingIntervalOption;
                        setPingInterval(value);
                        if (value !== 'custom') {
                          setPingCustomCron('');
                        }
                      }}
                      className="w-full pl-10 pr-4 py-2 mt-1 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 bg-white"
                    >
                      <option value="5m">每5分钟</option>
                      <option value="15m">每15分钟</option>
                      <option value="1h">每小时</option>
                      <option value="24h">每天</option>
                      <option value="custom">自定义 Cron 表达式</option>
                    </select>
                  </div>
                </div>
                <div className="flex flex-col justify-start">
                  <label className="block text-sm font-medium text-slate-700 mb-1">
                    每次检查最大域名数
                  </label>
                  <input
                    type="number"
                    className="border rounded px-3 py-2 w-full mt-1"
                    value={pingMaxTargets}
                    min={1}
                    max={200}
                    onChange={(e) => setPingMaxTargets(Number(e.target.value))}
                  />
                  <p className="text-xs text-slate-500 mt-1">建议值：10-100</p>
                </div>
              </div>
              {pingInterval === 'custom' && (
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">
                    Cron 表达式
                  </label>
                  <input
                    type="text"
                    className={`w-full px-4 py-2 border rounded-lg focus:outline-none focus:ring-2 font-mono text-sm ${
                      pingCustomCron && !pingCronValidation.valid
                        ? 'border-red-300 focus:ring-red-500/20 focus:border-red-500'
                        : 'border-gray-200 focus:ring-blue-500/20 focus:border-blue-500'
                    }`}
                    value={pingCustomCron}
                    onChange={(e) => {
                      setPingCustomCron(e.target.value);
                    }}
                    placeholder="*/5 * * * *"
                  />
                  {pingCustomCron && !pingCronValidation.valid && (
                    <p className="text-xs text-red-600 mt-1">
                      {pingCronValidation.error}
                    </p>
                  )}
                  <p className="text-xs text-slate-500 mt-1">
                    格式：分钟 小时 日 月 星期（用空格分隔）。例如：<code className="bg-slate-100 px-1 rounded">*/5 * * * *</code> 表示每5分钟
                  </p>
                </div>
              )}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">
                    超时时间 (ms)
                  </label>
                  <input
                    type="number"
                    className="border rounded px-3 py-2 w-full mt-1"
                    value={pingTimeoutMs}
                    min={1000}
                    onChange={(e) => setPingTimeoutMs(Number(e.target.value))}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">
                    最大延迟 (ms)
                  </label>
                  <input
                    type="number"
                    className="border rounded px-3 py-2 w-full mt-1"
                    value={pingMaxLatencyMs}
                    min={100}
                    onChange={(e) => setPingMaxLatencyMs(Number(e.target.value))}
                  />
                  <p className="text-xs text-slate-500 mt-1">超出视为失败</p>
                </div>
              </div>
            </>
          )}

          <div className="pt-2 flex justify-end items-center gap-3">
            <button
              onClick={handleSavePingSettings}
              disabled={loading}
              className="flex items-center gap-2 px-6 py-2 bg-green-600 text-white font-medium rounded-lg hover:bg-green-700 transition-colors shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? (
                <Loader2 size={18} className="animate-spin" />
              ) : (
                <Save size={18} />
              )}
              保存监测设置
            </button>
            {pingSaveStatus === 'success' && (
              <div className="flex items-center gap-1 text-emerald-600 text-sm">
                <CheckCircle2 size={16} /> 已保存
              </div>
            )}
            {pingSaveStatus === 'error' && (
              <div className="flex items-center gap-1 text-red-600 text-sm">
                <AlertCircle size={16} /> 保存失败
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
