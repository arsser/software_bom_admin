import {
  createBatchWithRows,
  type BomBatchRow,
} from './bomBatches';
import type { BomRowRecord } from './bomParser';
import {
  extractHttpUrlFromDownloadCell,
  fileBasename,
} from './bomRowFields';
import type { BomJsonKeyMap } from './bomScannerSettings';
import { fetchBomScannerSettings } from './bomScannerSettings';
import {
  assertPipelineDistributionReady,
  runBomSyncPipeline,
  SYNC_PIPELINE_PHASE_LABEL,
  type SyncPipelinePhase,
  type SyncPipelineProgress,
  type SyncPipelineResult,
} from './bomSyncPipeline';

export type PatchPipelinePhase = SyncPipelinePhase | 'create_batch';

export const PATCH_PIPELINE_PHASE_LABEL: Record<PatchPipelinePhase, string> = {
  ...SYNC_PIPELINE_PHASE_LABEL,
  create_batch: '创建 Hot fix 版本',
};

export type PatchPipelineProgress = {
  phase: PatchPipelinePhase;
  message: string;
  batchId?: string;
  batchName?: string;
  rowCount?: number;
  jobId?: string;
};

export type PatchUrlEntry = {
  url: string;
  /** 该链接的硬件平台 */
  arch: string;
};

export type CreatePatchBatchInput = {
  productId: string;
  /** 版本名；空则自动生成 patch-YYYYMMDD-HHmm */
  batchName?: string;
  /** 每条链接及其硬件平台 */
  urls: PatchUrlEntry[];
  /** 写入各行「备注」 */
  description: string;
  /** 模块列，默认 PATCH */
  module?: string;
  /** 是否同步 Artifactory-ext（默认 true） */
  doExt?: boolean;
  /** 是否飞书扫描/上传/清单（默认 true） */
  doFeishu?: boolean;
  signal?: AbortSignal;
  onProgress?: (p: PatchPipelineProgress) => void;
};

export type CreatePatchBatchResult = SyncPipelineResult;

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** 本地时区：patch-YYYYMMDD-HHmm */
export function suggestedPatchBatchName(now = new Date()): string {
  const y = now.getFullYear();
  const mo = pad2(now.getMonth() + 1);
  const d = pad2(now.getDate());
  const h = pad2(now.getHours());
  const mi = pad2(now.getMinutes());
  return `patch-${y}${mo}${d}-${h}${mi}`;
}

/**
 * 从多行文本解析 Artifactory http(s) 链接（支持 markdown 链接、忽略空行与 # 注释）。
 */
export function parseArtifactoryUrlsFromText(text: string): { urls: string[]; errors: string[] } {
  const urls: string[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  const lines = text.split(/\r?\n/);
  lines.forEach((line, idx) => {
    const raw = line.trim();
    if (!raw || raw.startsWith('#')) return;
    const http = extractHttpUrlFromDownloadCell(raw);
    if (!http) {
      errors.push(`第 ${idx + 1} 行：无法解析为 http(s) 链接`);
      return;
    }
    if (!/artifactory/i.test(http)) {
      errors.push(`第 ${idx + 1} 行：不是 Artifactory 链接`);
      return;
    }
    if (seen.has(http)) return;
    seen.add(http);
    urls.push(http);
  });
  return { urls, errors };
}

function componentNameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const base = fileBasename(decodeURIComponent(u.pathname));
    return base || 'package';
  } catch {
    return fileBasename(url) || 'package';
  }
}

export function buildPatchBomRows(
  entries: PatchUrlEntry[],
  description: string,
  keyMap: BomJsonKeyMap,
  opts?: { moduleLabel?: string },
): { headerOrder: string[]; rows: BomRowRecord[] } {
  const moduleLabel = (opts?.moduleLabel?.trim() || 'PATCH').trim() || 'PATCH';
  const colDownload = keyMap.downloadUrl[0] ?? '下载路径';
  const colMd5 = keyMap.expectedMd5[0] ?? 'MD5';
  const colRemark = keyMap.remark?.[0] ?? '备注';
  const colModule = keyMap.module?.[0] ?? '模块';
  const colComponent = keyMap.component?.[0] ?? '组件名';
  const colArch = keyMap.arch?.[0] ?? '硬件平台';
  const colSize = keyMap.fileSizeBytes?.[0];

  const headerOrder = [colModule, colComponent, colArch, colDownload, colMd5, colRemark];
  if (colSize) headerOrder.push(colSize);

  const remark = description.trim();
  const rows: BomRowRecord[] = entries.map((entry) => {
    const arch = entry.arch.trim();
    const url = entry.url.trim();
    const row: BomRowRecord = {
      [colModule]: moduleLabel,
      [colComponent]: componentNameFromUrl(url),
      [colArch]: arch,
      [colRemark]: remark,
    };
    for (const k of keyMap.downloadUrl?.length ? keyMap.downloadUrl : [colDownload]) {
      if (k.trim()) row[k.trim()] = url;
    }
    for (const k of keyMap.expectedMd5?.length ? keyMap.expectedMd5 : [colMd5]) {
      if (k.trim()) row[k.trim()] = '';
    }
    if (colSize) row[colSize] = '';
    return row;
  });

  return { headerOrder, rows };
}

/**
 * 新建补丁版本并按勾选阶段跑同步流水线。
 */
export async function createPatchBatchAndRunPipeline(
  input: CreatePatchBatchInput,
): Promise<CreatePatchBatchResult> {
  const productId = input.productId.trim();
  if (!productId) throw new Error('请选择产品');
  const entries = input.urls
    .map((e) => ({ url: e.url.trim(), arch: e.arch.trim() }))
    .filter((e) => e.url);
  if (entries.length === 0) throw new Error('请至少提供一个 Artifactory 链接');
  for (const e of entries) {
    if (!/^https?:\/\//i.test(e.url) || !/artifactory/i.test(e.url)) {
      throw new Error(`无效的 Artifactory 链接：${e.url.slice(0, 120)}`);
    }
    if (!e.arch) {
      throw new Error(`请为链接指定硬件平台：${e.url.slice(0, 80)}`);
    }
  }
  const description = input.description.trim();
  if (!description) throw new Error('请填写必要说明');

  const doExt = input.doExt !== false;
  const doFeishu = input.doFeishu !== false;
  await assertPipelineDistributionReady(productId, { doExt, doFeishu });

  const report = (p: PatchPipelineProgress) => input.onProgress?.(p);
  const signal = input.signal;

  const config = await fetchBomScannerSettings();
  const keyMap = config.jsonKeyMap;
  const batchName = (input.batchName?.trim() || suggestedPatchBatchName()).trim();
  const moduleLabel = (input.module?.trim() || 'PATCH').trim() || 'PATCH';
  const { headerOrder, rows } = buildPatchBomRows(entries, description, keyMap, {
    moduleLabel,
  });

  report({
    phase: 'create_batch',
    message: `创建版本「${batchName}」…`,
    batchName,
    rowCount: rows.length,
  });
  if (signal?.aborted) throw new DOMException('已取消', 'AbortError');
  const batchId = await createBatchWithRows({
    name: batchName,
    productId,
    originalBomUrl: '',
    headerOrder,
    rows,
  });
  report({
    phase: 'create_batch',
    message: `已创建版本，共 ${rows.length} 行`,
    batchId,
    batchName,
    rowCount: rows.length,
  });

  const mapProgress = (p: SyncPipelineProgress): PatchPipelineProgress => ({
    phase: p.phase,
    message: p.message,
    batchId: p.batchId,
    batchName: p.batchName,
    rowCount: p.rowCount,
    jobId: p.jobId,
  });

  return runBomSyncPipeline({
    batchId,
    batchName,
    doExt,
    doFeishu,
    enrichMd5: true,
    signal,
    onProgress: (p) => report(mapProgress(p)),
  });
}

/** @deprecated 仅兼容类型引用 */
export type { BomBatchRow };
