import { supabase } from './supabase';
import { formatFunctionsInvokeError } from './supabaseFunctionsInvokeError';
import {
  buildFeishuFileWebUrl,
  buildFeishuFolderWebUrl,
  buildFeishuSheetWebUrl,
  fetchFeishuSettings,
  normalizeFeishuWebBaseUrl,
} from './feishuSettings';

export type FeishuPackageManifestEntry = {
  rel_path: string;
  file_name: string;
  md5: string;
  size_bytes: number;
  file_token: string;
  download_url: string;
  uploaded_at?: string | null;
};

export type FeishuPackageManifestGetResult =
  | {
      ok: true;
      productId: string;
      productName?: string;
      exists: boolean;
      version: number;
      updated_at: string | null;
      entries: FeishuPackageManifestEntry[];
      entryCount?: number;
      manifestFileToken?: string;
      message?: string;
    }
  | { ok: false; error: string };

export type FeishuPackageManifestRefreshResult =
  | {
      ok: true;
      async: true;
      jobId: string;
      productId: string;
      message?: string;
      reused?: boolean;
    }
  | { ok: false; error: string };

function mapEntry(raw: Record<string, unknown>, webBaseUrl = ''): FeishuPackageManifestEntry {
  const fileToken = String(raw.file_token ?? raw.fileToken ?? '').trim();
  const existing = String(raw.download_url ?? raw.downloadUrl ?? '').trim();
  const web = buildFeishuFileWebUrl(fileToken, webBaseUrl);
  const downloadUrl =
    web ||
    (existing && !/open\.feishu\.cn\/open-apis\//i.test(existing) ? existing : '');
  return {
    rel_path: String(raw.rel_path ?? raw.relPath ?? ''),
    file_name: String(raw.file_name ?? raw.fileName ?? ''),
    md5: String(raw.md5 ?? '').toLowerCase(),
    size_bytes: Number(raw.size_bytes ?? raw.sizeBytes ?? 0) || 0,
    file_token: fileToken,
    download_url: downloadUrl,
    uploaded_at:
      typeof raw.uploaded_at === 'string'
        ? raw.uploaded_at
        : typeof raw.uploadedAt === 'string'
          ? raw.uploadedAt
          : null,
  };
}

/** 读取产品飞书根目录下 meta/package-manifest.json */
export async function fetchFeishuPackageManifest(productId: string): Promise<FeishuPackageManifestGetResult> {
  const { data, error } = await supabase.functions.invoke<Record<string, unknown>>('feishu-package-manifest', {
    body: { action: 'get', productId },
  });
  if (error) {
    return { ok: false, error: await formatFunctionsInvokeError(error) };
  }
  if (!data || typeof data !== 'object' || typeof data.ok !== 'boolean') {
    return { ok: false, error: '清单读取返回格式异常' };
  }
  if (!data.ok) {
    return { ok: false, error: String(data.error ?? '读取失败') };
  }
  const entriesRaw = Array.isArray(data.entries) ? data.entries : [];
  let webBaseUrl = normalizeFeishuWebBaseUrl(data.webBaseUrl);
  if (!webBaseUrl) {
    try {
      const cfg = await fetchFeishuSettings();
      webBaseUrl = cfg?.webBaseUrl ?? '';
    } catch {
      /* ignore */
    }
  }
  return {
    ok: true,
    productId: String(data.productId ?? productId),
    productName: typeof data.productName === 'string' ? data.productName : undefined,
    exists: Boolean(data.exists),
    version: Number(data.version ?? 1) || 1,
    updated_at: typeof data.updated_at === 'string' ? data.updated_at : null,
    entries: entriesRaw
      .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x))
      .map((x) => mapEntry(x, webBaseUrl)),
    entryCount: typeof data.entryCount === 'number' ? data.entryCount : entriesRaw.length,
    manifestFileToken: typeof data.manifestFileToken === 'string' ? data.manifestFileToken : undefined,
    message: typeof data.message === 'string' ? data.message : undefined,
  };
}

/** 入队扫描并刷新 package-manifest.json */
export async function requestFeishuPackageManifestRefresh(
  productId: string,
): Promise<FeishuPackageManifestRefreshResult> {
  const { data, error } = await supabase.functions.invoke<Record<string, unknown>>('feishu-package-manifest', {
    body: { action: 'refresh', productId },
  });
  if (error) {
    return { ok: false, error: await formatFunctionsInvokeError(error) };
  }
  if (!data || typeof data !== 'object' || typeof data.ok !== 'boolean') {
    return { ok: false, error: '刷新请求返回格式异常' };
  }
  if (!data.ok) {
    return { ok: false, error: String(data.error ?? '入队失败') };
  }
  if (!data.jobId) {
    return { ok: false, error: '入队成功但未返回 jobId' };
  }
  return {
    ok: true,
    async: true,
    jobId: String(data.jobId),
    productId: String(data.productId ?? productId),
    message: typeof data.message === 'string' ? data.message : undefined,
    reused: Boolean(data.reused),
  };
}

export type FeishuProductVersionDir = {
  name: string;
  folderToken: string;
  folderUrl: string | null;
  batchId: string | null;
  batchName: string | null;
  sheetToken: string | null;
  sheetUrl: string | null;
  sheetTitle: string | null;
  expectedSheetTitle: string | null;
  hasSheet: boolean;
};

export type FeishuProductVersionDirsResult =
  | {
      ok: true;
      productId: string;
      productName?: string;
      sheetTitle: string;
      sheetTitlePattern?: string;
      dirs: FeishuProductVersionDir[];
    }
  | { ok: false; error: string };

/** 列出产品飞书根下一级子目录（排除 meta），并检测「软件包清单」表与关联批次 */
export async function fetchFeishuProductVersionDirs(
  productId: string,
): Promise<FeishuProductVersionDirsResult> {
  const { data, error } = await supabase.functions.invoke<Record<string, unknown>>('feishu-package-manifest', {
    body: { action: 'list_dirs', productId },
  });
  if (error) {
    return { ok: false, error: await formatFunctionsInvokeError(error) };
  }
  if (!data || typeof data !== 'object' || typeof data.ok !== 'boolean') {
    return { ok: false, error: '目录列表返回格式异常' };
  }
  if (!data.ok) {
    return { ok: false, error: String(data.error ?? '列出目录失败') };
  }
  let webBaseUrl = normalizeFeishuWebBaseUrl(data.webBaseUrl);
  if (!webBaseUrl) {
    try {
      const cfg = await fetchFeishuSettings();
      webBaseUrl = cfg?.webBaseUrl ?? '';
    } catch {
      /* ignore */
    }
  }
  const dirsRaw = Array.isArray(data.dirs) ? data.dirs : [];
  return {
    ok: true,
    productId: String(data.productId ?? productId),
    productName: typeof data.productName === 'string' ? data.productName : undefined,
    sheetTitle: typeof data.sheetTitle === 'string' ? data.sheetTitle : '软件包清单',
    sheetTitlePattern:
      typeof data.sheetTitlePattern === 'string' ? data.sheetTitlePattern : undefined,
    dirs: dirsRaw
      .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x))
      .map((x) => {
        const folderToken = String(x.folderToken ?? '');
        const sheetToken = x.sheetToken != null && String(x.sheetToken) ? String(x.sheetToken) : null;
        const existingSheetUrl = x.sheetUrl != null && String(x.sheetUrl) ? String(x.sheetUrl) : null;
        const existingFolderUrl = x.folderUrl != null && String(x.folderUrl) ? String(x.folderUrl) : null;
        return {
          name: String(x.name ?? ''),
          folderToken,
          folderUrl: existingFolderUrl || (folderToken ? buildFeishuFolderWebUrl(folderToken, webBaseUrl) : null),
          batchId: x.batchId != null && String(x.batchId) ? String(x.batchId) : null,
          batchName: x.batchName != null && String(x.batchName) ? String(x.batchName) : null,
          sheetToken,
          sheetUrl:
            existingSheetUrl ||
            (sheetToken ? buildFeishuSheetWebUrl(sheetToken, webBaseUrl) : null),
          sheetTitle: x.sheetTitle != null && String(x.sheetTitle) ? String(x.sheetTitle) : null,
          expectedSheetTitle:
            x.expectedSheetTitle != null && String(x.expectedSheetTitle)
              ? String(x.expectedSheetTitle)
              : null,
          hasSheet: Boolean(x.hasSheet) || Boolean(sheetToken),
        };
      }),
  };
}

export type FeishuDeleteVersionSheetResult =
  | { ok: true; message?: string; dirName?: string; sheetToken?: string }
  | { ok: false; error: string };

/** 删除版本目录下的「软件包清单」飞书电子表格 */
export async function deleteFeishuVersionSheet(params: {
  productId: string;
  folderToken: string;
  sheetToken?: string | null;
}): Promise<FeishuDeleteVersionSheetResult> {
  const { data, error } = await supabase.functions.invoke<Record<string, unknown>>('feishu-package-manifest', {
    body: {
      action: 'delete_version_sheet',
      productId: params.productId,
      folderToken: params.folderToken,
      sheetToken: params.sheetToken || undefined,
    },
  });
  if (error) {
    return { ok: false, error: await formatFunctionsInvokeError(error) };
  }
  if (!data || typeof data !== 'object' || typeof data.ok !== 'boolean') {
    return { ok: false, error: '删除请求返回格式异常' };
  }
  if (!data.ok) {
    return { ok: false, error: String(data.error ?? '删除失败') };
  }
  return {
    ok: true,
    message: typeof data.message === 'string' ? data.message : undefined,
    dirName: typeof data.dirName === 'string' ? data.dirName : undefined,
    sheetToken: typeof data.sheetToken === 'string' ? data.sheetToken : undefined,
  };
}
