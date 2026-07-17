import { supabase } from './supabase';
import { formatFunctionsInvokeError } from './supabaseFunctionsInvokeError';

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

function mapEntry(raw: Record<string, unknown>): FeishuPackageManifestEntry {
  const fileToken = String(raw.file_token ?? raw.fileToken ?? '').trim();
  const downloadUrl =
    String(raw.download_url ?? raw.downloadUrl ?? '').trim() ||
    (fileToken
      ? `https://open.feishu.cn/open-apis/drive/v1/files/${encodeURIComponent(fileToken)}/download`
      : '');
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
  return {
    ok: true,
    productId: String(data.productId ?? productId),
    productName: typeof data.productName === 'string' ? data.productName : undefined,
    exists: Boolean(data.exists),
    version: Number(data.version ?? 1) || 1,
    updated_at: typeof data.updated_at === 'string' ? data.updated_at : null,
    entries: entriesRaw
      .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x))
      .map(mapEntry),
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
