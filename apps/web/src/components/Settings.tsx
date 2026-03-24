import React, { useState, useEffect } from 'react';
import { Save, Clock, Loader2, CheckCircle2, AlertCircle, Server, Key } from 'lucide-react';
import { usePingStore } from '../stores/pingStore';
import { getAppConfig } from '../lib/appConfig';
import {
  fetchArtifactorySettings,
  saveArtifactorySettings,
  type ArtifactoryConfig,
} from '../lib/artifactorySettings';

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

      {/* Artifactory（MD5 校验等） */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6 space-y-4">
        <div className="flex items-center gap-2">
          <Key size={18} className="text-amber-600" />
          <h3 className="text-lg font-medium text-slate-800">Artifactory 凭证</h3>
        </div>
        <p className="text-sm text-slate-500">
          用于 <span className="font-medium text-slate-700">MD5 校验</span> 页批量请求 Storage API。主实例与扩展实例可分别配置 Base URL 与 API Key。
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
        <div className="flex justify-end items-center gap-3 pt-2">
          <button
            type="button"
            onClick={handleSaveArtifactory}
            disabled={artifactoryLoading}
            className="flex items-center gap-2 px-6 py-2 bg-amber-600 text-white font-medium rounded-lg hover:bg-amber-700 transition-colors shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
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
