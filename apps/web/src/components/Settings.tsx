import React, { useState, useEffect } from 'react';
import {
  Save,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Server,
  Key,
  Package,
  Zap,
  Cloud,
  Eye,
  EyeOff,
  ChevronRight,
  ChevronDown,
} from 'lucide-react';
import { getAppConfig } from '../lib/appConfig';
import {
  fetchArtifactorySettings,
  saveArtifactorySettings,
  type ArtifactoryConfig,
} from '../lib/artifactorySettings';
import { fetchFeishuSettings, saveFeishuSettings, type FeishuConfig } from '../lib/feishuSettings';
import {
  testFeishuAuth,
  testFeishuListDrive,
  testFeishuCreateChildFolder,
  type FeishuAuthTestResult,
  type FeishuListDriveTestResult,
  type FeishuCreateFolderTestResult,
} from '../lib/feishuAuthTest';
import {
  fetchBomScannerSettings,
  mergeWorkerTuning,
  saveBomScannerSettings,
  type BomScannerConfig,
  type BomWorkerTuning,
} from '../lib/bomScannerSettings';
import { getArtifactoryApiInfo, type ApiInfoResult } from '../lib/artifactoryApi';
import {
  testBomExtArtifactoryRepo,
  type BomExtRepoTestOutcome,
} from '../lib/bomExtArtifactoryRepoTest';

/** 设置页内所有「测试」按钮与 feishu_assistant 设置页「测试连接」一致：白底、灰边框、浅灰悬停 */
const settingsTestButtonSm =
  'inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg bg-white border border-gray-300 text-slate-700 hover:bg-gray-50 shadow-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed';

const settingsTestButtonLg =
  'inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-white border border-gray-300 text-slate-700 hover:bg-gray-50 shadow-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed';

const settingsTestIconClass = 'text-orange-500 shrink-0';
const settingsTestSpinnerClass = 'text-slate-500 shrink-0 animate-spin';

/** 设置页测试结果：成功绿 / 失败红，简要信息默认展示，完整 JSON 可展开 */
const SettingsTestResultPanel: React.FC<{
  ok: boolean;
  summary: React.ReactNode;
  detail: unknown;
}> = ({ ok, summary, detail }) => {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    setOpen(false);
  }, [detail]);
  const shell = ok
    ? 'border-emerald-200 bg-emerald-50/70'
    : 'border-red-200 bg-red-50/70';
  const iconWrap = ok ? 'text-emerald-600' : 'text-red-600';
  const summaryTone = ok ? 'text-emerald-950' : 'text-red-950';

  return (
    <div className={`mt-2 rounded-lg border ${shell} overflow-hidden`}>
      <div className="flex items-start gap-2 px-3 py-2.5">
        <span className={`shrink-0 mt-0.5 ${iconWrap}`}>
          {ok ? <CheckCircle2 size={18} aria-hidden /> : <AlertCircle size={18} aria-hidden />}
        </span>
        <div className={`min-w-0 flex-1 text-sm leading-snug ${summaryTone}`}>{summary}</div>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="shrink-0 inline-flex items-center gap-0.5 text-xs font-medium text-slate-600 hover:text-slate-900 py-0.5 px-1 rounded-md hover:bg-white/60 transition-colors"
        >
          {open ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
          {open ? '收起' : '详情'}
        </button>
      </div>
      {open ? (
        <pre className="text-xs font-mono border-t border-slate-200/80 bg-white/85 text-slate-800 p-3 max-h-72 overflow-auto whitespace-pre-wrap break-all">
          {JSON.stringify(detail, null, 2)}
        </pre>
      ) : null}
    </div>
  );
};

/** Artifactory 元数据里 path 常为 "/" 表示仓库根；不要拼成 repo// */
function formatArtifactoryRepoPath(repo?: string, path?: string | null): string | null {
  if (repo == null) return null;
  const repoNorm = String(repo).trim().replace(/\/+$/, '');
  if (!repoNorm) return null;
  if (path == null) return repoNorm;
  const raw = String(path).trim();
  if (raw === '' || raw === '/') return repoNorm;
  const p = raw.replace(/^\/+/, '');
  return `${repoNorm}/${p}`;
}

function bomExtRepoSummary(o: BomExtRepoTestOutcome): React.ReactNode {
  if (o.ok) {
    const r = o.apiResult;
    if (r) {
      const path = formatArtifactoryRepoPath(r.info?.repo, r.info?.path);
      return (
        <>
          <span className="font-semibold">成功</span>
          <span className="text-emerald-900/90">
            {typeof r.status === 'number' ? ` · HTTP ${r.status}` : ''}
            {path ? ` · ${path}` : ''}
          </span>
        </>
      );
    }
    return (
      <>
        <span className="font-semibold">成功</span>
        <span className="text-emerald-900/90"> · 无详细返回（见 JSON）</span>
      </>
    );
  }
  return (
    <>
      <span className="font-semibold">失败</span>
      <span className="text-red-900/90"> · {o.error || o.apiResult?.error || '未知错误'}</span>
      {o.requestedUrl ? (
        <span className="block text-xs font-normal text-red-800/80 mt-1 truncate" title={o.requestedUrl}>
          {o.requestedUrl}
        </span>
      ) : null}
    </>
  );
}

function feishuListDriveSummary(r: FeishuListDriveTestResult): React.ReactNode {
  if (r.ok) {
    const n = r.itemCount ?? r.items?.length ?? 0;
    return (
      <>
        <span className="font-semibold">成功</span>
        <span className="text-emerald-900/90">
          {typeof r.listHttpStatus === 'number' ? ` · HTTP ${r.listHttpStatus}` : ''}
          {` · 本页 ${n} 条`}
          {r.hasMore ? '（仍有下一页）' : ''}
        </span>
      </>
    );
  }
  return (
    <>
      <span className="font-semibold">失败</span>
      <span className="text-red-900/90"> · {r.error || '未知错误'}</span>
    </>
  );
}

function feishuCreateFolderSummary(r: FeishuCreateFolderTestResult): React.ReactNode {
  if (r.ok) {
    return (
      <>
        <span className="font-semibold">成功</span>
        <span className="text-emerald-900/90">
          {typeof r.createHttpStatus === 'number' ? ` · HTTP ${r.createHttpStatus}` : ''}
          {r.usedName ? ` · 已创建「${r.usedName}」` : ''}
        </span>
        {r.newFolderUrl ? (
          <a
            href={r.newFolderUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="block text-xs font-normal text-emerald-800 underline underline-offset-2 mt-1 truncate max-w-full"
          >
            在飞书中打开新文件夹
          </a>
        ) : null}
      </>
    );
  }
  return (
    <>
      <span className="font-semibold">失败</span>
      <span className="text-red-900/90"> · {r.error || '未知错误'}</span>
    </>
  );
}

function artifactoryApiSummary(r: ApiInfoResult): React.ReactNode {
  if (r.ok) {
    const path = formatArtifactoryRepoPath(r.info?.repo, r.info?.path);
    return (
      <>
        <span className="font-semibold">成功</span>
        <span className="text-emerald-900/90">
          {typeof r.status === 'number' ? ` · HTTP ${r.status}` : ''}
          {path ? ` · ${path}` : ''}
        </span>
      </>
    );
  }
  return (
    <>
      <span className="font-semibold">失败</span>
      <span className="text-red-900/90">
        {' · '}
        {r.error || '未知错误'}
      </span>
      {r.url ? (
        <span className="block text-xs font-normal text-red-800/80 mt-1 truncate" title={r.url}>
          {r.url}
        </span>
      ) : null}
    </>
  );
}

function feishuAuthSummary(r: FeishuAuthTestResult): React.ReactNode {
  if (r.ok) {
    return (
      <>
        <span className="font-semibold">成功</span>
        <span className="text-emerald-900/90">
          {typeof r.httpStatus === 'number' ? ` · HTTP ${r.httpStatus}` : ''}
          {typeof r.expireSeconds === 'number' ? ` · token 约 ${r.expireSeconds} 秒有效` : ''}
        </span>
      </>
    );
  }
  return (
    <>
      <span className="font-semibold">失败</span>
      <span className="text-red-900/90"> · {r.error || '未知错误'}</span>
    </>
  );
}

export const Settings: React.FC = () => {
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
  const [bomExtRepoTestLoading, setBomExtRepoTestLoading] = useState(false);
  const [bomExtRepoTestOutcome, setBomExtRepoTestOutcome] = useState<BomExtRepoTestOutcome | null>(null);
  const [bomFeishuRootTestLoading, setBomFeishuRootTestLoading] = useState(false);
  const [bomFeishuRootTestOutcome, setBomFeishuRootTestOutcome] = useState<FeishuListDriveTestResult | null>(null);
  const [bomFeishuMkdirTestName, setBomFeishuMkdirTestName] = useState('');
  const [bomFeishuMkdirTestLoading, setBomFeishuMkdirTestLoading] = useState(false);
  const [bomFeishuMkdirTestOutcome, setBomFeishuMkdirTestOutcome] = useState<FeishuCreateFolderTestResult | null>(null);
  const [showJsonKeyMap, setShowJsonKeyMap] = useState(false);
  const [showMainApiKey, setShowMainApiKey] = useState(false);
  const [showExtApiKey, setShowExtApiKey] = useState(false);
  const [feishu, setFeishu] = useState<FeishuConfig>({ appId: '', appSecret: '' });
  const [feishuLoading, setFeishuLoading] = useState(false);
  const [feishuSaveStatus, setFeishuSaveStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [feishuTestLoading, setFeishuTestLoading] = useState(false);
  const [feishuTestResult, setFeishuTestResult] = useState<FeishuAuthTestResult | null>(null);
  const [showFeishuSecret, setShowFeishuSecret] = useState(false);

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
      } catch (e) {
        console.error(e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const f = await fetchFeishuSettings();
        if (cancelled || !f) return;
        setFeishu(f);
      } catch (e) {
        console.error(e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cfg = await fetchBomScannerSettings();
        if (cancelled) return;
        setBomScanner(cfg);
        setBomKeyMapJson(JSON.stringify(cfg.jsonKeyMap, null, 2));
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
        groupSegment: o.groupSegment !== undefined ? arr('groupSegment') : undefined,
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
        feishuDriveRootFolderToken: bomScanner.feishuDriveRootFolderToken?.trim() ?? '',
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

  const handleTestBomExtRepo = async () => {
    if (!bomScanner) return;
    const repoKey = bomScanner.extArtifactoryRepo?.trim() ?? '';
    if (!repoKey) {
      alert('请填写外部 Artifactory 目标仓库 key');
      return;
    }
    setBomExtRepoTestLoading(true);
    setBomExtRepoTestOutcome(null);
    try {
      const o = await testBomExtArtifactoryRepo({ repoKey, previewConfig: artifactory });
      setBomExtRepoTestOutcome(o);
    } finally {
      setBomExtRepoTestLoading(false);
    }
  };

  const handleTestBomFeishuRoot = async () => {
    if (!bomScanner) return;
    const folder = bomScanner.feishuDriveRootFolderToken?.trim() ?? '';
    if (!folder) {
      alert('请填写飞书云盘根目录 folder_token');
      return;
    }
    setBomFeishuRootTestLoading(true);
    setBomFeishuRootTestOutcome(null);
    try {
      const r = await testFeishuListDrive({
        appId: feishu.appId.trim(),
        appSecret: feishu.appSecret,
        folderToken: folder,
      });
      setBomFeishuRootTestOutcome(r);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setBomFeishuRootTestOutcome({ ok: false, error: msg });
    } finally {
      setBomFeishuRootTestLoading(false);
    }
  };

  const handleTestBomFeishuMkdir = async () => {
    if (!bomScanner) return;
    const parent = bomScanner.feishuDriveRootFolderToken?.trim() ?? '';
    if (!parent) {
      alert('请填写飞书云盘根目录 folder_token');
      return;
    }
    setBomFeishuMkdirTestLoading(true);
    setBomFeishuMkdirTestOutcome(null);
    try {
      const r = await testFeishuCreateChildFolder({
        appId: feishu.appId.trim(),
        appSecret: feishu.appSecret,
        parentFolderToken: parent,
        childFolderName: bomFeishuMkdirTestName.trim() || undefined,
      });
      setBomFeishuMkdirTestOutcome(r);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setBomFeishuMkdirTestOutcome({ ok: false, action: 'create_folder', error: msg });
    } finally {
      setBomFeishuMkdirTestLoading(false);
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

  const handleSaveFeishu = async () => {
    try {
      setFeishuLoading(true);
      const next: FeishuConfig = {
        appId: feishu.appId.trim(),
        appSecret: feishu.appSecret,
      };
      await saveFeishuSettings(next);
      setFeishuSaveStatus('success');
      setTimeout(() => setFeishuSaveStatus('idle'), 3000);
    } catch (err: any) {
      setFeishuSaveStatus('error');
      alert('保存飞书配置失败: ' + (err.message || '未知错误'));
      setTimeout(() => setFeishuSaveStatus('idle'), 3000);
    } finally {
      setFeishuLoading(false);
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
      const results = await getArtifactoryApiInfo({
        urls: [url],
        previewConfig: artifactory,
      });

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

  const handleTestFeishu = async () => {
    setFeishuTestLoading(true);
    setFeishuTestResult(null);
    try {
      const r = await testFeishuAuth({
        appId: feishu.appId.trim(),
        appSecret: feishu.appSecret,
      });
      setFeishuTestResult(r);
      if (!r.ok) {
        alert('飞书凭据测试失败：' + (r.error || '未知错误'));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setFeishuTestResult({ ok: false, error: msg });
      alert('飞书凭据测试失败：' + msg);
    } finally {
      setFeishuTestLoading(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-slate-900">系统设置</h2>
        <p className="text-slate-500">Artifactory、BOM 扫描、飞书等</p>
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
        {bomScanner && (
          <div className="space-y-4">
            <div className="space-y-4 border-b border-gray-100 pb-4">
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
                  className="w-full max-w-[11rem] px-4 py-2 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
                />
                <p className="text-xs text-slate-500 mt-1">保存后由后台服务从数据库读取并按该间隔入队。</p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-x-4 gap-y-3 text-sm">
                <label className="block space-y-1 min-w-0">
                  <span className="text-xs text-slate-600">heartbeatMs（5000–120000）</span>
                  <input
                    type="number"
                    min={5000}
                    max={120000}
                    value={bomScanner.workerTuning.heartbeatMs}
                    onChange={(e) => patchWorkerTuning({ heartbeatMs: Number(e.target.value) })}
                    className="w-full px-4 py-2 border border-gray-200 rounded-lg font-mono text-xs focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
                  />
                  <span className="text-[11px] text-slate-400 leading-snug">心跳 / 进度上报间隔（毫秒）</span>
                </label>
                <label className="block space-y-1 min-w-0">
                  <span className="text-xs text-slate-600">httpTimeoutMs（≥1000）</span>
                  <input
                    type="number"
                    min={1000}
                    value={bomScanner.workerTuning.httpTimeoutMs}
                    onChange={(e) => patchWorkerTuning({ httpTimeoutMs: Number(e.target.value) })}
                    className="w-full px-4 py-2 border border-gray-200 rounded-lg font-mono text-xs focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
                  />
                  <span className="text-[11px] text-slate-400 leading-snug">单次 HTTP 超时（毫秒）</span>
                </label>
                <label className="block space-y-1 min-w-0 sm:col-span-2 md:col-span-1">
                  <span className="text-xs text-slate-600">httpRetries（0~10）</span>
                  <input
                    type="number"
                    min={0}
                    max={10}
                    value={bomScanner.workerTuning.httpRetries}
                    onChange={(e) => patchWorkerTuning({ httpRetries: Number(e.target.value) })}
                    className="w-full max-w-[11rem] px-4 py-2 border border-gray-200 rounded-lg font-mono text-xs focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
                  />
                  <span className="block text-[11px] text-slate-400 leading-snug mt-0.5">
                    失败重试次数上限
                  </span>
                </label>
              </div>
            </div>

            <div className="rounded-lg border border-slate-200 bg-slate-50/80 p-4 space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  外部 Artifactory 目标仓库 key
                </label>
                <input
                  type="text"
                  value={bomScanner?.extArtifactoryRepo ?? ''}
                  onChange={(e) =>
                    setBomScanner((s) => (s ? { ...s, extArtifactoryRepo: e.target.value } : s))
                  }
                  disabled={!bomScanner}
                  placeholder="例如 software-bom-bucket"
                  className="w-full max-w-xl px-4 py-2 border border-gray-200 rounded-lg font-mono text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 disabled:opacity-50"
                />
                
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => void handleTestBomExtRepo()}
                    disabled={!bomScanner || bomExtRepoTestLoading}
                    className={settingsTestButtonSm}
                  >
                    {bomExtRepoTestLoading ? (
                      <Loader2 size={14} className={settingsTestSpinnerClass} />
                    ) : (
                      <Zap size={14} className={settingsTestIconClass} />
                    )}
                    测试外部仓库
                  </button>

                </div>
                {bomExtRepoTestOutcome !== null ? (
                  <SettingsTestResultPanel
                    ok={bomExtRepoTestOutcome.ok}
                    summary={bomExtRepoSummary(bomExtRepoTestOutcome)}
                    detail={bomExtRepoTestOutcome}
                  />
                ) : null}
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  飞书云盘根目录 <code className="font-mono text-xs font-normal text-slate-600">folder_token</code>
                </label>
                <input
                  type="text"
                  value={bomScanner?.feishuDriveRootFolderToken ?? ''}
                  onChange={(e) =>
                    setBomScanner((s) => (s ? { ...s, feishuDriveRootFolderToken: e.target.value } : s))
                  }
                  disabled={!bomScanner}
                  placeholder="云文档里「批次文件夹的父目录」对应的 folder_token"
                  className="w-full max-w-xl px-4 py-2 border border-gray-200 rounded-lg font-mono text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 disabled:opacity-50"
                />
                <p className="text-xs text-slate-500 mt-1 leading-relaxed max-w-2xl">
                  填的是飞书<strong>云文档</strong>里某个文件夹的{' '}
                  <code className="bg-slate-100 px-1 rounded text-[11px]">folder_token</code>
                  （一串字母数字，不是文件夹显示名称、也不是整段网页链接）。在本产品中，它表示「根」：其<strong>下一级</strong>应有与
                  BOM 批次名一致的子文件夹；扫描会在该子文件夹内按与外部仓库相同的相对路径匹配文件。token 可从飞书开放平台云文档相关
                  API 的返回字段、或官方文档说明的方式取得；填好后可用下方「测试飞书根目录」确认能否列出子项。
                </p>
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => void handleTestBomFeishuRoot()}
                    disabled={!bomScanner || bomFeishuRootTestLoading}
                    className={settingsTestButtonSm}
                  >
                    {bomFeishuRootTestLoading ? (
                      <Loader2 size={14} className={settingsTestSpinnerClass} />
                    ) : (
                      <Zap size={14} className={settingsTestIconClass} />
                    )}
                    测试飞书根目录
                  </button>
                  <span className="text-xs text-slate-500">
                    使用「飞书」卡片当前 App ID / Secret 及本字段 folder_token，拉取第一页文件列表；成败均显示在下方。
                  </span>
                </div>
                {bomFeishuRootTestOutcome !== null ? (
                  <SettingsTestResultPanel
                    ok={bomFeishuRootTestOutcome.ok}
                    summary={feishuListDriveSummary(bomFeishuRootTestOutcome)}
                    detail={bomFeishuRootTestOutcome}
                  />
                ) : null}

                <div className="mt-4 pt-3 border-t border-slate-200/80 space-y-2">
                  <label className="block text-sm font-medium text-slate-700">
                    测试新建子文件夹（可选名称）
                  </label>
                  <input
                    type="text"
                    value={bomFeishuMkdirTestName}
                    onChange={(e) => setBomFeishuMkdirTestName(e.target.value)}
                    disabled={!bomScanner}
                    placeholder="留空则自动生成 sbom-test-时间戳-随机串"
                    className="w-full max-w-xl px-4 py-2 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 disabled:opacity-50"
                  />
                  <p className="text-xs text-slate-500 leading-relaxed max-w-2xl">
                    调用飞书{' '}
                    <code className="bg-slate-100 px-1 rounded text-[11px]">POST …/drive/v1/files/create_folder</code>
                    ，在上方「云盘根目录」下<strong>真实创建</strong>一个子文件夹（需应用具备编辑该父目录等权限，与列表不同）。重名会失败；用完后可在飞书云文档中手动删除。
                  </p>
                  <div className="flex flex-wrap items-center gap-2 pt-0.5">
                    <button
                      type="button"
                      onClick={() => void handleTestBomFeishuMkdir()}
                      disabled={!bomScanner || bomFeishuMkdirTestLoading}
                      className={settingsTestButtonSm}
                    >
                      {bomFeishuMkdirTestLoading ? (
                        <Loader2 size={14} className={settingsTestSpinnerClass} />
                      ) : (
                        <Zap size={14} className={settingsTestIconClass} />
                      )}
                      测试新建子文件夹
                    </button>
                  </div>
                  {bomFeishuMkdirTestOutcome !== null ? (
                    <SettingsTestResultPanel
                      ok={bomFeishuMkdirTestOutcome.ok}
                      summary={feishuCreateFolderSummary(bomFeishuMkdirTestOutcome)}
                      detail={bomFeishuMkdirTestOutcome}
                    />
                  ) : null}
                </div>
              </div>
            </div>

            <div className="rounded-lg border border-slate-200 bg-slate-50/80 p-3 space-y-2">
              <button
                type="button"
                onClick={() => setShowJsonKeyMap((v) => !v)}
                className="text-sm font-medium text-slate-800 hover:text-slate-950"
              >
                {showJsonKeyMap ? '▼' : '▶'} jsonKeyMap（JSON）
              </button>
              {showJsonKeyMap ? (
                <div className="space-y-2 pt-1">
                  <textarea
                    value={bomKeyMapJson}
                    onChange={(e) => setBomKeyMapJson(e.target.value)}
                    rows={12}
                    spellCheck={false}
                    className="w-full px-4 py-3 border border-gray-200 rounded-lg font-mono text-xs focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 text-slate-800 bg-white"
                  />
                  <p className="text-xs text-slate-500">
                    键名：<code className="bg-gray-100 px-1 rounded">downloadUrl</code>、
                    <code className="bg-gray-100 px-1 rounded">expectedMd5</code>、
                    <code className="bg-gray-100 px-1 rounded">arch</code>、
                    <code className="bg-gray-100 px-1 rounded">extUrl</code>、
                    <code className="bg-gray-100 px-1 rounded">releaseVersion</code>、
                    <code className="bg-gray-100 px-1 rounded">releaseBatch</code>、
                    <code className="bg-gray-100 px-1 rounded">moduleName</code>、
                    <code className="bg-gray-100 px-1 rounded">groupSegment</code>、
                    <code className="bg-gray-100 px-1 rounded">fileSizeBytes</code>、
                    <code className="bg-gray-100 px-1 rounded">extFileSizeBytes</code>、
                    <code className="bg-gray-100 px-1 rounded">remark</code>（可选）；值为字符串数组，表示 jsonb 中可能出现的列名。
                  </p>
                </div>
              ) : null}
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
          用于 worker 自动下载、Edge 查询与手工复制下载命令。凭据统一读取数据库{' '}
          <code className="bg-slate-100 px-1 rounded text-xs">system_settings.artifactory_config</code>。
        </p>
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">内部 Artifactory Base URL</label>
            <input
              type="url"
              value={artifactory.artifactoryBaseUrl ?? ''}
              onChange={(e) => setArtifactory((a) => ({ ...a, artifactoryBaseUrl: e.target.value }))}
              placeholder="https://artifactory.example.com"
              className="w-full px-4 py-2 border border-gray-200 rounded-lg font-mono text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">内部 Artifactory API Key</label>
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
            <label className="block text-sm font-medium text-slate-700 mb-1">外部 Artifactory Base URL</label>
            <input
              type="url"
              value={artifactory.artifactoryExtBaseUrl ?? ''}
              onChange={(e) => setArtifactory((a) => ({ ...a, artifactoryExtBaseUrl: e.target.value }))}
              placeholder="https://artifactory-ext.example.com"
              className="w-full px-4 py-2 border border-gray-200 rounded-lg font-mono text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">外部 Artifactory API Key</label>
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
            </div>

            <div className="flex justify-end gap-3 md:justify-end">
              <button
                type="button"
                onClick={handleTestArtifactory}
                disabled={artifactoryTestLoading}
                className={settingsTestButtonLg}
              >
                {artifactoryTestLoading ? (
                  <Loader2 size={18} className={settingsTestSpinnerClass} />
                ) : (
                  <Zap size={18} className={settingsTestIconClass} />
                )}
                测试凭证
              </button>
            </div>
          </div>

          {artifactoryTestResult ? (
            <SettingsTestResultPanel
              ok={artifactoryTestResult.ok}
              summary={artifactoryApiSummary(artifactoryTestResult)}
              detail={artifactoryTestResult}
            />
          ) : null}
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

      {/* 飞书：应用凭据（云盘根目录 folder_token 在「BOM 本地扫描」中与 ext 仓库 key 同属 bom_scanner） */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6 space-y-4">
        <div className="flex items-center gap-2">
          <Cloud size={18} className="text-violet-600" />
          <h3 className="text-lg font-medium text-slate-800">飞书</h3>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">飞书应用 App ID</label>
            <input
              type="text"
              value={feishu.appId}
              onChange={(e) => setFeishu((f) => ({ ...f, appId: e.target.value }))}
              placeholder="cli_xxxxxxxx"
              autoComplete="off"
              className="w-full px-4 py-2 border border-gray-200 rounded-lg font-mono text-sm focus:outline-none focus:ring-2 focus:ring-violet-500/20 focus:border-violet-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">飞书应用 App Secret</label>
            <div className="relative">
              <input
                type={showFeishuSecret ? 'text' : 'password'}
                value={feishu.appSecret}
                onChange={(e) => setFeishu((f) => ({ ...f, appSecret: e.target.value }))}
                placeholder="保存后写入数据库"
                autoComplete="off"
                className="w-full px-4 py-2 pr-11 border border-gray-200 rounded-lg font-mono text-sm focus:outline-none focus:ring-2 focus:ring-violet-500/20 focus:border-violet-500"
              />
              <button
                type="button"
                onClick={() => setShowFeishuSecret((v) => !v)}
                aria-label={showFeishuSecret ? '隐藏 App Secret' : '显示 App Secret'}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1.5 rounded-md text-slate-500 hover:text-slate-800 hover:bg-slate-100 transition-colors"
              >
                {showFeishuSecret ? <EyeOff size={18} aria-hidden /> : <Eye size={18} aria-hidden />}
              </button>
            </div>
          </div>
        </div>

        <div className="border-t border-gray-100 pt-4 space-y-3">
          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => void handleTestFeishu()}
              disabled={feishuTestLoading}
              className={settingsTestButtonLg}
            >
              {feishuTestLoading ? (
                <Loader2 size={18} className={settingsTestSpinnerClass} />
              ) : (
                <Zap size={18} className={settingsTestIconClass} />
              )}
              测试应用凭据
            </button>
          </div>
          {feishuTestResult ? (
            <SettingsTestResultPanel
              ok={feishuTestResult.ok}
              summary={feishuAuthSummary(feishuTestResult)}
              detail={feishuTestResult}
            />
          ) : null}
        </div>

        <div className="flex justify-end items-center gap-3 pt-2">
          <button
            type="button"
            onClick={() => void handleSaveFeishu()}
            disabled={feishuLoading}
            className="flex items-center gap-2 px-6 py-2 bg-green-600 text-white font-medium rounded-lg hover:bg-green-700 transition-colors shadow-sm focus:outline-none focus:ring-2 focus:ring-green-500/40 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {feishuLoading ? <Loader2 size={18} className="animate-spin" /> : <Save size={18} />}
            保存飞书配置
          </button>
          {feishuSaveStatus === 'success' && (
            <div className="flex items-center gap-1 text-emerald-600 text-sm">
              <CheckCircle2 size={16} /> 已保存
            </div>
          )}
          {feishuSaveStatus === 'error' && (
            <div className="flex items-center gap-1 text-red-600 text-sm">
              <AlertCircle size={16} /> 保存失败
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
