import { fetchArtifactorySettings } from './artifactorySettings';
import {
  createBatchWithRows,
  fetchBomRows,
  fetchLocalFileInfoByMd5,
  mergeHeaderOrder,
  refreshBomRowStatusesForBatch,
  updateBomBatchHeaderOrder,
  updateBomRowBomAndStatusFetchErrors,
  type BomBatchRow,
} from './bomBatches';
import { enrichBomRowsFromArtifactory } from './bomArtifactoryEnrich';
import {
  downloadJobIsTerminal,
  fetchBomDownloadJobsForBatch,
  requestBomItDownload,
  type BomDownloadJob,
} from './bomDownloadJobs';
import {
  extSyncJobIsTerminal,
  fetchBomExtSyncJobsForBatch,
  requestBomExtSync,
  type BomExtSyncJob,
} from './bomExtSyncJobs';
import { requestBomFeishuScan } from './bomFeishuScan';
import {
  fetchBomFeishuScanJobsForBatch,
  feishuScanJobIsTerminal,
  type BomFeishuScanJob,
} from './bomFeishuScanJobs';
import {
  fetchBomFeishuUploadJobsForBatch,
  feishuUploadJobIsTerminal,
  requestBomFeishuUpload,
  type BomFeishuUploadJob,
} from './bomFeishuUploadJobs';
import {
  fetchBomFeishuVersionSheetJobsForBatch,
  feishuVersionSheetJobIsActive,
  requestBomFeishuVersionSheet,
  type BomFeishuVersionSheetJob,
} from './bomFeishuVersionSheet';
import type { BomRowRecord } from './bomParser';
import {
  extractExpectedMd5FromRow,
  extractHttpUrlFromDownloadCell,
  fileBasename,
  rowEligibleForItPull,
} from './bomRowFields';
import type { BomJsonKeyMap, BomScannerConfig } from './bomScannerSettings';
import { fetchBomScannerSettings } from './bomScannerSettings';
import { fetchProductDistributionSettings } from './products';
import { feishuScanErrorBlocksFeishuUpload } from './bomRowStatus';

export type PatchPipelinePhase =
  | 'idle'
  | 'create_batch'
  | 'enrich_md5'
  | 'download'
  | 'wait_verified'
  | 'ext_sync'
  | 'feishu_scan'
  | 'feishu_upload'
  | 'version_sheet'
  | 'done'
  | 'failed';

export const PATCH_PIPELINE_PHASE_LABEL: Record<PatchPipelinePhase, string> = {
  idle: '待命',
  create_batch: '创建 Hot fix 版本',
  enrich_md5: '补全 MD5',
  download: '拉取到本地',
  wait_verified: '等待本地校验',
  ext_sync: '同步 Artifactory-ext',
  feishu_scan: '扫描飞书目录',
  feishu_upload: '上传到飞书',
  version_sheet: '生成软件包清单',
  done: '已完成',
  failed: '失败',
};

export type PatchPipelineProgress = {
  phase: PatchPipelinePhase;
  message: string;
  batchId?: string;
  batchName?: string;
  rowCount?: number;
  jobId?: string;
};

export type CreatePatchBatchInput = {
  productId: string;
  /** 版本名；空则自动生成 patch-YYYYMMDD-HHmm */
  batchName?: string;
  /** 每行一条 Artifactory http(s) 链接；也可传入多行文本由 parse 解析 */
  urls: string[];
  /** 写入各行「备注」 */
  description: string;
  /** 写入各行「硬件平台」 */
  arch: string;
  /** 模块列，默认 PATCH */
  module?: string;
  signal?: AbortSignal;
  onProgress?: (p: PatchPipelineProgress) => void;
};

export type CreatePatchBatchResult = {
  batchId: string;
  batchName: string;
  rowCount: number;
  /** 无拉取任务时为 null（本地索引已命中） */
  downloadJobId: string | null;
  extSyncJobId: string;
  feishuScanJobId: string;
  /** 无需上传时为 null（飞书侧已全部 present / 全局去重） */
  feishuUploadJobId: string | null;
  /** 版本目录「软件包清单」飞书表任务 */
  versionSheetJobId: string;
  versionSheetUrl: string | null;
};

const POLL_MS = 2000;
const VERIFY_TIMEOUT_MS = 10 * 60 * 1000;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('已取消', 'AbortError'));
      return;
    }
    const t = setTimeout(() => resolve(), ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new DOMException('已取消', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('已取消', 'AbortError');
}

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
  urls: string[],
  description: string,
  keyMap: BomJsonKeyMap,
  opts?: { moduleLabel?: string; arch?: string },
): { headerOrder: string[]; rows: BomRowRecord[] } {
  const moduleLabel = (opts?.moduleLabel?.trim() || 'PATCH').trim() || 'PATCH';
  const arch = (opts?.arch ?? '').trim();
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
  const rows: BomRowRecord[] = urls.map((url) => {
    const row: BomRowRecord = {
      [colModule]: moduleLabel,
      [colComponent]: componentNameFromUrl(url),
      [colArch]: arch,
      [colRemark]: remark,
    };
    // 写入全部别名，避免 DB jsonKeyMap 与前端首键不一致导致 SQL 抽不出 downloadUrl
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

async function pollUntil<T>(
  fetchOne: () => Promise<T | null>,
  isDone: (v: T) => boolean,
  opts: { signal?: AbortSignal; timeoutMs?: number; label: string },
): Promise<T> {
  const started = Date.now();
  for (;;) {
    throwIfAborted(opts.signal);
    const v = await fetchOne();
    if (v != null && isDone(v)) return v;
    if (opts.timeoutMs != null && Date.now() - started > opts.timeoutMs) {
      throw new Error(`${opts.label}超时（>${Math.round(opts.timeoutMs / 1000)}s）`);
    }
    await sleep(POLL_MS, opts.signal);
  }
}

async function waitDownloadJob(
  batchId: string,
  jobId: string,
  signal?: AbortSignal,
): Promise<BomDownloadJob> {
  const job = await pollUntil(
    async () => {
      const jobs = await fetchBomDownloadJobsForBatch(batchId, 20);
      return jobs.find((j) => j.id === jobId) ?? null;
    },
    (j) => downloadJobIsTerminal(j.status),
    { signal, label: '本地拉取' },
  );
  if (job.status !== 'succeeded') {
    throw new Error(`本地拉取失败：${job.lastMessage?.trim() || job.status}`);
  }
  return job;
}

async function waitExtSyncJob(
  batchId: string,
  jobId: string,
  signal?: AbortSignal,
): Promise<BomExtSyncJob> {
  const job = await pollUntil(
    async () => {
      const jobs = await fetchBomExtSyncJobsForBatch(batchId, 20);
      return jobs.find((j) => j.id === jobId) ?? null;
    },
    (j) => extSyncJobIsTerminal(j.status),
    { signal, label: 'Artifactory-ext 同步' },
  );
  if (job.status !== 'succeeded') {
    throw new Error(`Artifactory-ext 同步失败：${job.lastMessage?.trim() || job.status}`);
  }
  return job;
}

async function waitFeishuScanJob(
  batchId: string,
  jobId: string,
  signal?: AbortSignal,
): Promise<BomFeishuScanJob> {
  const job = await pollUntil(
    async () => {
      const jobs = await fetchBomFeishuScanJobsForBatch(batchId, 20);
      return jobs.find((j) => j.id === jobId) ?? null;
    },
    (j) => feishuScanJobIsTerminal(j.status),
    { signal, label: '飞书扫描' },
  );
  if (job.status !== 'succeeded') {
    throw new Error(`飞书扫描失败：${job.message?.trim() || job.status}`);
  }
  return job;
}

async function waitFeishuUploadJob(
  batchId: string,
  jobId: string,
  signal?: AbortSignal,
): Promise<BomFeishuUploadJob> {
  const job = await pollUntil(
    async () => {
      const jobs = await fetchBomFeishuUploadJobsForBatch(batchId, 20);
      return jobs.find((j) => j.id === jobId) ?? null;
    },
    (j) => feishuUploadJobIsTerminal(j.status),
    { signal, label: '飞书上传' },
  );
  if (job.status !== 'succeeded') {
    throw new Error(`飞书上传失败：${job.lastMessage?.trim() || job.status}`);
  }
  return job;
}

async function waitFeishuVersionSheetJob(
  batchId: string,
  jobId: string,
  signal?: AbortSignal,
): Promise<BomFeishuVersionSheetJob> {
  const job = await pollUntil(
    async () => {
      const jobs = await fetchBomFeishuVersionSheetJobsForBatch(batchId, 20);
      return jobs.find((j) => j.id === jobId) ?? null;
    },
    (j) => !feishuVersionSheetJobIsActive(j.status),
    { signal, label: '生成软件包清单' },
  );
  if (job.status !== 'succeeded') {
    throw new Error(`生成软件包清单失败：${job.message?.trim() || job.status}`);
  }
  return job;
}

async function waitAllRowsVerifiedOk(
  batchId: string,
  expectedCount: number,
  signal?: AbortSignal,
): Promise<BomBatchRow[]> {
  const started = Date.now();
  for (;;) {
    throwIfAborted(signal);
    await refreshBomRowStatusesForBatch(batchId);
    const rows = await fetchBomRows(batchId);
    if (rows.length !== expectedCount) {
      throw new Error(`行数异常：期望 ${expectedCount}，实际 ${rows.length}`);
    }
    const ok = rows.every((r) => r.status.local === 'verified_ok');
    if (ok) return rows;

    const failed = rows.filter(
      (r) => r.status.local === 'verified_fail' || r.status.local === 'error',
    );
    if (failed.length > 0 && Date.now() - started > 15_000) {
      const detail = failed
        .slice(0, 5)
        .map((r) => r.status.local_fetch_error || r.status.local)
        .join('；');
      throw new Error(`本地校验未通过（${failed.length}/${rows.length}）：${detail}`);
    }

    if (Date.now() - started > VERIFY_TIMEOUT_MS) {
      const pending = rows.filter((r) => r.status.local !== 'verified_ok').length;
      throw new Error(`等待本地校验超时：仍有 ${pending} 行未通过`);
    }
    await sleep(POLL_MS, signal);
  }
}

/**
 * 新建补丁版本并自动串完：补 MD5 → 本地拉取 → 校验 → ext → 飞书扫描 → 飞书上传。
 */
export async function createPatchBatchAndRunPipeline(
  input: CreatePatchBatchInput,
): Promise<CreatePatchBatchResult> {
  const productId = input.productId.trim();
  if (!productId) throw new Error('请选择产品');
  const urls = input.urls.map((u) => u.trim()).filter(Boolean);
  if (urls.length === 0) throw new Error('请至少提供一个 Artifactory 链接');
  for (const u of urls) {
    if (!/^https?:\/\//i.test(u) || !/artifactory/i.test(u)) {
      throw new Error(`无效的 Artifactory 链接：${u.slice(0, 120)}`);
    }
  }
  const description = input.description.trim();
  if (!description) throw new Error('请填写必要说明');
  const arch = input.arch.trim();
  if (!arch) throw new Error('请填写硬件平台');

  const report = (p: PatchPipelineProgress) => input.onProgress?.(p);
  const signal = input.signal;

  const dist = await fetchProductDistributionSettings(productId);
  if (!dist.extArtifactoryRepo.trim() || !dist.feishuDriveRootFolderToken.trim()) {
    throw new Error('该产品分发配置不完整（需 Artifactory-ext 仓库与飞书根目录）');
  }

  const config: BomScannerConfig = await fetchBomScannerSettings();
  const keyMap = config.jsonKeyMap;
  const batchName = (input.batchName?.trim() || suggestedPatchBatchName()).trim();
  const moduleLabel = (input.module?.trim() || 'PATCH').trim() || 'PATCH';
  const { headerOrder, rows } = buildPatchBomRows(urls, description, keyMap, {
    moduleLabel,
    arch,
  });

  report({ phase: 'create_batch', message: `创建版本「${batchName}」…`, batchName, rowCount: rows.length });
  throwIfAborted(signal);
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

  report({
    phase: 'enrich_md5',
    message: '从 Artifactory Storage API 补全 MD5…',
    batchId,
    batchName,
    rowCount: rows.length,
  });
  throwIfAborted(signal);
  const af = await fetchArtifactorySettings();
  if (!af) throw new Error('无法读取 Artifactory 配置，请检查系统设置');

  let loaded = await fetchBomRows(batchId);
  const { rows: enriched, summary } = await enrichBomRowsFromArtifactory(loaded, keyMap, af);
  // 将 MD5 写到全部别名，保证 SQL bom_extract_expected_md5 能读到
  for (const r of enriched) {
    const md5 = extractExpectedMd5FromRow(r.bom_row, keyMap);
    if (!md5) continue;
    const next = { ...r.bom_row };
    for (const k of keyMap.expectedMd5?.length ? keyMap.expectedMd5 : ['MD5']) {
      if (k.trim()) next[k.trim()] = md5;
    }
    r.bom_row = next;
  }
  const toEnsure = [keyMap.fileSizeBytes?.[0]].filter(Boolean) as string[];
  const ho = mergeHeaderOrder(headerOrder, toEnsure);
  for (let i = 0; i < enriched.length; i += 1) {
    const a = loaded[i];
    const b = enriched[i];
    if (!a || !b) continue;
    const bomChanged = JSON.stringify(a.bom_row) !== JSON.stringify(b.bom_row);
    const itErrChanged = (a.status.it_fetch_error ?? null) !== (b.status.it_fetch_error ?? null);
    if (bomChanged || itErrChanged) {
      await updateBomRowBomAndStatusFetchErrors(b.id, b.bom_row, {
        it_fetch_error: b.status.it_fetch_error ?? null,
      });
    }
  }
  if (toEnsure.length) await updateBomBatchHeaderOrder(batchId, ho);

  loaded = await fetchBomRows(batchId);
  const missingMd5 = loaded.filter((r) => !extractExpectedMd5FromRow(r.bom_row, keyMap));
  if (missingMd5.length > 0) {
    const tip =
      summary.apiRespondedErrorCount > 0
        ? `（Storage API 失败 ${summary.apiRespondedErrorCount} 行）`
        : summary.apiOkButNoMd5Count > 0
          ? `（API 成功但无 MD5 ${summary.apiOkButNoMd5Count} 行）`
          : '';
    throw new Error(`有 ${missingMd5.length} 行未能补全 MD5，无法继续同步${tip}`);
  }
  report({
    phase: 'enrich_md5',
    message: `已补全 MD5 ${summary.md5FilledCount || loaded.length} 行`,
    batchId,
    batchName,
    rowCount: loaded.length,
  });

  // 补全 MD5 后先对齐本地索引：文件已在盘上时会变为 verified_ok，此时不应再入队拉取
  report({
    phase: 'download',
    message: '检查本地是否已有文件…',
    batchId,
    batchName,
    rowCount: loaded.length,
  });
  throwIfAborted(signal);
  await refreshBomRowStatusesForBatch(batchId);
  loaded = await fetchBomRows(batchId);

  const md5List = loaded
    .map((r) => extractExpectedMd5FromRow(r.bom_row, keyMap))
    .filter((m): m is string => Boolean(m));
  const localInfoByMd5 = await fetchLocalFileInfoByMd5(md5List);
  const pullIds = loaded.filter((r) => rowEligibleForItPull(r, keyMap, localInfoByMd5)).map((r) => r.id);
  const verifiedCount = loaded.filter((r) => r.status.local === 'verified_ok').length;

  let downloadJobId: string | null = null;
  if (pullIds.length === 0) {
    if (verifiedCount === loaded.length) {
      report({
        phase: 'download',
        message: `本地已有全部 ${loaded.length} 个文件，跳过拉取`,
        batchId,
        batchName,
        rowCount: loaded.length,
      });
    } else {
      const sample = loaded
        .filter((r) => r.status.local !== 'verified_ok')
        .slice(0, 3)
        .map((r) => {
          const md5 = extractExpectedMd5FromRow(r.bom_row, keyMap) ?? '无MD5';
          return `${r.status.local}/${md5.slice(0, 8)}`;
        })
        .join(', ');
      throw new Error(
        `没有可拉取的行，且尚未全部校验通过（已通过 ${verifiedCount}/${loaded.length}）。状态示例：${sample || '—'}`,
      );
    }
  } else {
    report({
      phase: 'download',
      message: `入队本地拉取（${pullIds.length}/${loaded.length} 行）…`,
      batchId,
      batchName,
      rowCount: loaded.length,
    });
    throwIfAborted(signal);
    try {
      downloadJobId = await requestBomItDownload(batchId, pullIds);
    } catch (e) {
      // 竞态：入队瞬间本地索引已命中
      await refreshBomRowStatusesForBatch(batchId);
      loaded = await fetchBomRows(batchId);
      if (loaded.every((r) => r.status.local === 'verified_ok')) {
        report({
          phase: 'download',
          message: `本地已有全部文件，跳过拉取`,
          batchId,
          batchName,
          rowCount: loaded.length,
        });
      } else {
        throw e;
      }
    }
    if (downloadJobId) {
      report({
        phase: 'download',
        message: '正在拉取到本地…',
        batchId,
        batchName,
        rowCount: loaded.length,
        jobId: downloadJobId,
      });
      await waitDownloadJob(batchId, downloadJobId, signal);
    }
  }

  report({
    phase: 'wait_verified',
    message: '等待本地 MD5 校验通过…',
    batchId,
    batchName,
    rowCount: loaded.length,
  });
  await waitAllRowsVerifiedOk(batchId, loaded.length, signal);

  report({
    phase: 'ext_sync',
    message: '入队 Artifactory-ext 同步…',
    batchId,
    batchName,
    rowCount: loaded.length,
  });
  throwIfAborted(signal);
  const extSyncJobId = await requestBomExtSync(batchId, null);
  report({
    phase: 'ext_sync',
    message: '正在同步到 Artifactory-ext…',
    batchId,
    batchName,
    rowCount: loaded.length,
    jobId: extSyncJobId,
  });
  await waitExtSyncJob(batchId, extSyncJobId, signal);

  report({
    phase: 'feishu_scan',
    message: '入队飞书扫描（自动创建版本目录）…',
    batchId,
    batchName,
    rowCount: loaded.length,
  });
  throwIfAborted(signal);
  const scanRes = await requestBomFeishuScan(batchId, { autoCreateVersionFolder: true });
  if (!scanRes.ok) {
    throw new Error(scanRes.error || '飞书扫描入队失败');
  }
  const feishuScanJobId = scanRes.jobId;
  if (!feishuScanJobId) throw new Error('飞书扫描未返回任务 ID');
  report({
    phase: 'feishu_scan',
    message: '正在扫描飞书目录…',
    batchId,
    batchName,
    rowCount: loaded.length,
    jobId: feishuScanJobId,
  });
  await waitFeishuScanJob(batchId, feishuScanJobId, signal);

  // 全局去重：已 present 的可跳过上传；absent/error 仍入队
  loaded = await fetchBomRows(batchId);
  const uploadIds = loaded
    .filter((r) => {
      if (r.status.local !== 'verified_ok') return false;
      const f = r.status.feishu;
      if (f !== 'absent' && f !== 'error') return false;
      if (feishuScanErrorBlocksFeishuUpload(r.status.feishu_scan_error)) return false;
      return true;
    })
    .map((r) => r.id);
  const presentCount = loaded.filter((r) => r.status.feishu === 'present').length;

  let feishuUploadJobId: string | null = null;
  if (uploadIds.length === 0) {
    if (presentCount === loaded.length) {
      report({
        phase: 'feishu_upload',
        message: `飞书清单已覆盖全部 ${loaded.length} 个包（全局去重），跳过文件上传`,
        batchId,
        batchName,
        rowCount: loaded.length,
      });
    } else {
      const sample = loaded
        .slice(0, 5)
        .map((r) => `${r.status.feishu ?? 'not_scanned'}${r.status.feishu_scan_error ? '(有扫描错误)' : ''}`)
        .join(', ');
      throw new Error(
        `飞书扫描后没有可上传的行（present ${presentCount}/${loaded.length}）。状态：${sample}`,
      );
    }
  } else {
    report({
      phase: 'feishu_upload',
      message: `入队飞书上传（${uploadIds.length}/${loaded.length} 行；其余可全局去重）…`,
      batchId,
      batchName,
      rowCount: loaded.length,
    });
    throwIfAborted(signal);
    feishuUploadJobId = await requestBomFeishuUpload(batchId, uploadIds);
    report({
      phase: 'feishu_upload',
      message: '正在上传到飞书…',
      batchId,
      batchName,
      rowCount: loaded.length,
      jobId: feishuUploadJobId,
    });
    await waitFeishuUploadJob(batchId, feishuUploadJobId, signal);
  }

  // 无论是否实际上传文件，都必须在本版本目录生成「软件包清单」飞书表
  report({
    phase: 'version_sheet',
    message: '生成版本目录「软件包清单」…',
    batchId,
    batchName,
    rowCount: loaded.length,
  });
  throwIfAborted(signal);
  const sheetRes = await requestBomFeishuVersionSheet(batchId);
  if (!sheetRes.ok) {
    throw new Error(sheetRes.error || '软件包清单入队失败');
  }
  const versionSheetJobId = sheetRes.jobId;
  report({
    phase: 'version_sheet',
    message: sheetRes.reused ? '等待已有软件包清单任务…' : '正在生成软件包清单…',
    batchId,
    batchName,
    rowCount: loaded.length,
    jobId: versionSheetJobId,
  });
  const sheetJob = await waitFeishuVersionSheetJob(batchId, versionSheetJobId, signal);
  const versionSheetUrl = sheetJob.sheetUrl?.trim() || null;

  report({
    phase: 'done',
    message: versionSheetUrl
      ? `Hot fix 完成；软件包清单：${versionSheetUrl}`
      : 'Hot fix 已同步，软件包清单已生成',
    batchId,
    batchName,
    rowCount: loaded.length,
  });

  return {
    batchId,
    batchName,
    rowCount: loaded.length,
    downloadJobId,
    extSyncJobId,
    feishuScanJobId,
    feishuUploadJobId,
    versionSheetJobId,
    versionSheetUrl,
  };
}
