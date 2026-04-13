import React from 'react';
import type { BomExtRepoTestOutcome } from './bomExtArtifactoryRepoTest';
import type { FeishuListDriveTestResult, FeishuCreateFolderTestResult } from './feishuAuthTest';

/** Artifactory 元数据里 path 常为 "/" 表示仓库根；不要拼成 repo// */
export function formatArtifactoryRepoPath(repo?: string, path?: string | null): string | null {
  if (repo == null) return null;
  const repoNorm = String(repo).trim().replace(/\/+$/, '');
  if (!repoNorm) return null;
  if (path == null) return repoNorm;
  const raw = String(path).trim();
  if (raw === '' || raw === '/') return repoNorm;
  const p = raw.replace(/^\/+/, '');
  return `${repoNorm}/${p}`;
}

export function bomExtRepoSummary(o: BomExtRepoTestOutcome): React.ReactNode {
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

export function feishuListDriveSummary(r: FeishuListDriveTestResult): React.ReactNode {
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

export function feishuCreateFolderSummary(r: FeishuCreateFolderTestResult): React.ReactNode {
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
