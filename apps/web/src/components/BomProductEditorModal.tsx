import React, { useEffect, useState } from 'react';
import { Loader2, Save, X, Zap } from 'lucide-react';
import { fetchArtifactorySettings, type ArtifactoryConfig } from '../lib/artifactorySettings';
import { fetchFeishuSettings, type FeishuConfig } from '../lib/feishuSettings';
import {
  testFeishuListDrive,
  testFeishuCreateChildFolder,
  type FeishuListDriveTestResult,
  type FeishuCreateFolderTestResult,
} from '../lib/feishuAuthTest';
import { testBomExtArtifactoryRepo, type BomExtRepoTestOutcome } from '../lib/bomExtArtifactoryRepoTest';
import {
  createProduct,
  updateProduct,
  updateProductDistributionSettings,
  type Product,
} from '../lib/products';
import { SettingsTestResultPanel } from './SettingsTestResultPanel';
import {
  bomExtRepoSummary,
  feishuCreateFolderSummary,
  feishuListDriveSummary,
} from '../lib/distributionTestUi';

const testBtnSm =
  'inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg bg-white border border-gray-300 text-slate-700 hover:bg-gray-50 shadow-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed';
const testIconClass = 'text-orange-500 shrink-0';
const testSpinnerClass = 'text-slate-500 shrink-0 animate-spin';

const emptyForm = {
  name: '',
  extArtifactoryRepo: '',
  feishuDriveRootFolderToken: '',
};

export type BomProductEditorModalProps = {
  open: boolean;
  mode: 'create' | 'edit';
  /** 编辑模式下为当前产品 */
  product: Product | null;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
};

export const BomProductEditorModal: React.FC<BomProductEditorModalProps> = ({
  open,
  mode,
  product,
  onClose,
  onSaved,
}) => {
  const [form, setForm] = useState(emptyForm);
  const [saveBusy, setSaveBusy] = useState(false);

  const [artifactory, setArtifactory] = useState<ArtifactoryConfig | null>(null);
  const [feishu, setFeishu] = useState<FeishuConfig>({ appId: '', appSecret: '' });

  const [bomExtRepoTestLoading, setBomExtRepoTestLoading] = useState(false);
  const [bomExtRepoTestOutcome, setBomExtRepoTestOutcome] = useState<BomExtRepoTestOutcome | null>(null);
  const [bomFeishuRootTestLoading, setBomFeishuRootTestLoading] = useState(false);
  const [bomFeishuRootTestOutcome, setBomFeishuRootTestOutcome] = useState<FeishuListDriveTestResult | null>(
    null,
  );
  const [bomFeishuMkdirTestName, setBomFeishuMkdirTestName] = useState('');
  const [bomFeishuMkdirTestLoading, setBomFeishuMkdirTestLoading] = useState(false);
  const [bomFeishuMkdirTestOutcome, setBomFeishuMkdirTestOutcome] =
    useState<FeishuCreateFolderTestResult | null>(null);

  useEffect(() => {
    if (!open) return;
    if (mode === 'create') {
      setForm(emptyForm);
    } else if (product) {
      setForm({
        name: product.name,
        extArtifactoryRepo: product.extArtifactoryRepo,
        feishuDriveRootFolderToken: product.feishuDriveRootFolderToken,
      });
    }
    setBomExtRepoTestOutcome(null);
    setBomFeishuRootTestOutcome(null);
    setBomFeishuMkdirTestOutcome(null);
    setBomFeishuMkdirTestName('');
  }, [open, mode, product]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        const [a, f] = await Promise.all([fetchArtifactorySettings(), fetchFeishuSettings()]);
        if (cancelled) return;
        if (a) setArtifactory(a);
        if (f) setFeishu(f);
      } catch (e) {
        console.error(e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  const handleClose = () => {
    if (saveBusy) return;
    onClose();
  };

  const handleTestBomExtRepo = async () => {
    const repoKey = form.extArtifactoryRepo?.trim() ?? '';
    if (!repoKey) {
      alert('请填写外部 Artifactory 目标仓库 key');
      return;
    }
    if (!artifactory) {
      alert('尚未加载 Artifactory 配置，请稍后再试或先在系统设置中保存 Artifactory 凭证');
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
    const folder = form.feishuDriveRootFolderToken?.trim() ?? '';
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
    const parent = form.feishuDriveRootFolderToken?.trim() ?? '';
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

  const handleSubmit = async () => {
    const name = form.name.trim();
    const extRepo = form.extArtifactoryRepo.trim();
    const feishuRoot = form.feishuDriveRootFolderToken.trim();
    if (!name) {
      alert('请填写产品名称');
      return;
    }
    if (!extRepo) {
      alert('请填写外部 Artifactory 目标仓库 key');
      return;
    }
    if (!feishuRoot) {
      alert('请填写飞书云盘根目录 folder_token');
      return;
    }

    setSaveBusy(true);
    try {
      if (mode === 'create') {
        await createProduct({
          name,
          extArtifactoryRepo: extRepo,
          feishuDriveRootFolderToken: feishuRoot,
        });
      } else {
        if (!product) throw new Error('缺少产品信息');
        if (name !== product.name) {
          await updateProduct({ id: product.id, name });
        }
        await updateProductDistributionSettings({
          productId: product.id,
          extArtifactoryRepo: extRepo,
          feishuDriveRootFolderToken: feishuRoot,
        });
      }
      await onSaved();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setSaveBusy(false);
    }
  };

  if (!open) return null;

  const title = mode === 'create' ? '新建产品' : '编辑产品';
  const subtitle =
    mode === 'create'
      ? '填写名称与分发配置（与版本无关，全产品共用）。可先测试外部仓库与飞书根目录。'
      : '可修改名称与分发配置。测试功能使用系统设置中的 Artifactory / 飞书应用凭据。';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40"
      role="dialog"
      aria-modal="true"
      aria-labelledby="bom-product-editor-title"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !saveBusy) handleClose();
      }}
    >
      <div
        className="w-full max-w-lg rounded-xl border border-gray-200 bg-white shadow-xl max-h-[min(90vh,720px)] flex flex-col"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-gray-100 shrink-0">
          <div>
            <h3 id="bom-product-editor-title" className="text-lg font-semibold text-slate-900">
              {title}
            </h3>
            <p className="text-sm text-slate-500 mt-0.5">{subtitle}</p>
          </div>
          <button
            type="button"
            onClick={() => handleClose()}
            disabled={saveBusy}
            className="p-1.5 rounded-lg text-slate-500 hover:bg-slate-100 disabled:opacity-50"
            aria-label="关闭"
          >
            <X size={20} />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4 overflow-y-auto flex-1">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">产品名称</label>
            <input
              type="text"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="例如：某产品线"
              className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
              autoFocus={mode === 'create'}
              disabled={saveBusy}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">
              外部 Artifactory 目标仓库 key
            </label>
            <input
              type="text"
              value={form.extArtifactoryRepo}
              onChange={(e) => setForm((f) => ({ ...f, extArtifactoryRepo: e.target.value }))}
              placeholder="例如 software-bom-bucket"
              className="w-full px-3 py-2 border border-gray-200 rounded-lg font-mono text-sm"
              disabled={saveBusy}
            />
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <button
                type="button"
                onClick={() => void handleTestBomExtRepo()}
                disabled={bomExtRepoTestLoading || saveBusy}
                className={testBtnSm}
              >
                {bomExtRepoTestLoading ? (
                  <Loader2 size={14} className={testSpinnerClass} />
                ) : (
                  <Zap size={14} className={testIconClass} />
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
              飞书云盘根目录 <span className="font-mono font-normal text-slate-500">folder_token</span>
            </label>
            <input
              type="text"
              value={form.feishuDriveRootFolderToken}
              onChange={(e) =>
                setForm((f) => ({ ...f, feishuDriveRootFolderToken: e.target.value }))
              }
              placeholder="云文档中批次文件夹的父目录 token"
              className="w-full px-3 py-2 border border-gray-200 rounded-lg font-mono text-sm"
              disabled={saveBusy}
            />
            <p className="text-xs text-slate-500 mt-1">
              飞书应用凭据在「系统设置」中配置。
            </p>
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <button
                type="button"
                onClick={() => void handleTestBomFeishuRoot()}
                disabled={bomFeishuRootTestLoading || saveBusy}
                className={testBtnSm}
              >
                {bomFeishuRootTestLoading ? (
                  <Loader2 size={14} className={testSpinnerClass} />
                ) : (
                  <Zap size={14} className={testIconClass} />
                )}
                测试飞书根目录
              </button>
            </div>
            {bomFeishuRootTestOutcome !== null ? (
              <SettingsTestResultPanel
                ok={bomFeishuRootTestOutcome.ok}
                summary={feishuListDriveSummary(bomFeishuRootTestOutcome)}
                detail={bomFeishuRootTestOutcome}
              />
            ) : null}

            <div className="mt-4 pt-3 border-t border-slate-200/80 space-y-2">
              <label className="block text-sm font-medium text-slate-700">测试新建子文件夹（可选名称）</label>
              <input
                type="text"
                value={bomFeishuMkdirTestName}
                onChange={(e) => setBomFeishuMkdirTestName(e.target.value)}
                placeholder="留空则自动生成 sbom-test-时间戳-随机串"
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
                disabled={saveBusy}
              />
              <div className="flex flex-wrap items-center gap-2 pt-0.5">
                <button
                  type="button"
                  onClick={() => void handleTestBomFeishuMkdir()}
                  disabled={bomFeishuMkdirTestLoading || saveBusy}
                  className={testBtnSm}
                >
                  {bomFeishuMkdirTestLoading ? (
                    <Loader2 size={14} className={testSpinnerClass} />
                  ) : (
                    <Zap size={14} className={testIconClass} />
                  )}
                  飞书测试新建子文件夹
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

        <div className="flex justify-end gap-2 px-5 py-4 border-t border-gray-100 shrink-0">
          <button
            type="button"
            onClick={() => handleClose()}
            disabled={saveBusy}
            className="px-4 py-2 text-sm font-medium rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={saveBusy}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {saveBusy ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
            {mode === 'create' ? '创建产品' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
};
