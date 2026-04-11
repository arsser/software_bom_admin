import type { ArtifactoryConfig } from './artifactorySettings';
import { getArtifactoryApiInfo, type ApiInfoResult } from './artifactoryApi';

/** 拼出可在 Storage API 中解析的「外部实例 / 仓库根」浏览 URL（与 artifactory-api-info 中 toStorageApiUrl 输入约定一致） */
export function buildExtArtifactoryRepoBrowseUrl(extBaseUrl: string, repoKey: string): string | null {
  const key = String(repoKey ?? '').trim().replace(/^\/+|\/+$/g, '');
  if (!key) return null;
  let raw = String(extBaseUrl ?? '').trim();
  if (!raw) return null;
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
  raw = raw.replace(/\/+$/, '');
  try {
    const u = new URL(raw);
    const origin = u.origin;
    const pathname = u.pathname.replace(/\/+$/, '');
    const hasArt = /\/artifactory$/i.test(pathname);
    const prefix = hasArt ? `${origin}${pathname}` : `${origin}/artifactory`;
    const segments = key.split('/').filter(Boolean).map(encodeURIComponent).join('/');
    if (!segments) return null;
    return `${prefix}/${segments}/`;
  } catch {
    return null;
  }
}

export type BomExtRepoTestOutcome = {
  ok: boolean;
  requestedUrl?: string;
  apiResult?: ApiInfoResult;
  error?: string;
};

/**
 * 用外部 Base URL + API Key（previewConfig）对仓库 key 做一次 Storage GET（仓库根），不写库。
 */
export async function testBomExtArtifactoryRepo(options: {
  repoKey: string;
  previewConfig: Partial<ArtifactoryConfig>;
}): Promise<BomExtRepoTestOutcome> {
  const url = buildExtArtifactoryRepoBrowseUrl(
    options.previewConfig.artifactoryExtBaseUrl ?? '',
    options.repoKey,
  );
  if (!url) {
    return { ok: false, error: '请填写「外部 Artifactory Base URL」（Artifactory 凭证卡片）与仓库 key' };
  }
  try {
    const results = await getArtifactoryApiInfo({
      urls: [url],
      previewConfig: options.previewConfig,
    });
    const r = results[0];
    if (!r) {
      return { ok: false, requestedUrl: url, error: '未返回测试结果' };
    }
    return {
      ok: r.ok,
      requestedUrl: url,
      apiResult: r,
      error: r.ok ? undefined : r.error,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, requestedUrl: url, error: msg };
  }
}
