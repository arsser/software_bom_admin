import type { ArtifactoryConfig } from './artifactorySettings';
import type { BomBatchRow } from './bomBatches';
import type { BomJsonKeyMap } from './bomScannerSettings';
import {
  extractDownloadUrlRaw,
  extractExtUrlFromRow,
  extractHttpUrlFromDownloadCell,
  fileBasename,
} from './bomRowFields';

/** Bash 单引号安全转义 */
export function shellSingleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\''`)}'`;
}

function normalizeHost(base: string): string | null {
  const t = base.trim();
  if (!t) return null;
  try {
    const u = new URL(t.includes('://') ? t : `https://${t}`);
    return u.hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * 按下载 URL 主机与系统设置中的 Base URL 匹配内部/外部 Artifactory API Key（与 worker 的 host 校验语义一致）。
 */
export function pickArtifactoryApiKeyForUrl(
  downloadUrl: string,
  cfg: ArtifactoryConfig,
): { apiKey: string; keyKind: 'primary' | 'ext' } | null {
  let u: URL;
  try {
    u = new URL(downloadUrl);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  const extHost = normalizeHost(cfg.artifactoryExtBaseUrl ?? '');
  const priHost = normalizeHost(cfg.artifactoryBaseUrl ?? '');
  const extKey = (cfg.artifactoryExtApiKey ?? '').trim();
  const priKey = (cfg.artifactoryApiKey ?? '').trim();

  if (extHost && host === extHost) {
    if (extKey) return { apiKey: extKey, keyKind: 'ext' };
    return null;
  }
  if (priHost && host === priHost) {
    if (priKey) return { apiKey: priKey, keyKind: 'primary' };
    return null;
  }
  if (!priHost && !extHost) {
    if (priKey) return { apiKey: priKey, keyKind: 'primary' };
    if (extKey) return { apiKey: extKey, keyKind: 'ext' };
  }
  return null;
}

export function rowHasArtifactoryHttpUrl(row: BomBatchRow, keyMap: BomJsonKeyMap): boolean {
  const raw = extractDownloadUrlRaw(row.bom_row, keyMap);
  const url = raw ? extractHttpUrlFromDownloadCell(raw) : null;
  return Boolean(url && /artifactory/i.test(url));
}

/** ext_url 等别名列中的 http(s) Artifactory 链接（外部 Artifactory 写入后可批量复制 curl/wget） */
export function rowHasExtArtifactoryHttpUrl(row: BomBatchRow, keyMap: BomJsonKeyMap): boolean {
  const raw = extractExtUrlFromRow(row.bom_row, keyMap);
  const url = raw ? extractHttpUrlFromDownloadCell(raw) : null;
  return Boolean(url && /artifactory/i.test(url));
}

export function buildCurlDownloadCommand(url: string, apiKey: string, outFile: string): string {
  const q = shellSingleQuote;
  const fn = outFile.trim() || 'download.bin';
  return [
    'curl -fL',
    `-o ${q(fn)}`,
    `-H ${q(`Authorization: Bearer ${apiKey}`)}`,
    `-H ${q(`X-JFrog-Art-Api: ${apiKey}`)}`,
    q(url),
  ].join(' ');
}

export function buildWgetDownloadCommand(url: string, apiKey: string, outFile: string): string {
  const q = shellSingleQuote;
  const fn = outFile.trim() || 'download.bin';
  return [
    'wget',
    `-O ${q(fn)}`,
    `--header=${q(`Authorization: Bearer ${apiKey}`)}`,
    `--header=${q(`X-JFrog-Art-Api: ${apiKey}`)}`,
    q(url),
  ].join(' ');
}

export function buildCopyCommandsForRows(
  items: { row: BomBatchRow; displayLine: number }[],
  keyMap: BomJsonKeyMap,
  cfg: ArtifactoryConfig,
  tool: 'curl' | 'wget',
): { text: string; errors: string[] } {
  const errors: string[] = [];
  const blocks: string[] = [];
  for (const { row: lr, displayLine } of items) {
    const raw = extractDownloadUrlRaw(lr.bom_row, keyMap);
    const url = raw ? extractHttpUrlFromDownloadCell(raw) : null;
    if (!url || !/artifactory/i.test(url)) {
      errors.push(`第 ${displayLine} 行：无有效内部 Artifactory http(s) 链接`);
      continue;
    }
    const picked = pickArtifactoryApiKeyForUrl(url, cfg);
    if (!picked) {
      errors.push(
        `第 ${displayLine} 行：无法匹配 API Key（请核对系统设置中内部/外部 Base URL 与下载链接主机是否一致）`,
      );
      continue;
    }
    const pathOnly = url.split(/[?#]/)[0] ?? url;
    const out = fileBasename(pathOnly);
    const cmd =
      tool === 'curl'
        ? buildCurlDownloadCommand(url, picked.apiKey, out)
        : buildWgetDownloadCommand(url, picked.apiKey, out);
    blocks.push(`# 第 ${displayLine} 行 · ${picked.keyKind === 'ext' ? '外部' : '内部'} · ${out}`);
    blocks.push(cmd);
    blocks.push('');
  }
  return { text: blocks.join('\n').trimEnd(), errors };
}

export function buildCopyCommandsForExtRows(
  items: { row: BomBatchRow; displayLine: number }[],
  keyMap: BomJsonKeyMap,
  cfg: ArtifactoryConfig,
  tool: 'curl' | 'wget',
): { text: string; errors: string[] } {
  const errors: string[] = [];
  const blocks: string[] = [];
  for (const { row: lr, displayLine } of items) {
    const raw = extractExtUrlFromRow(lr.bom_row, keyMap);
    const url = raw ? extractHttpUrlFromDownloadCell(raw) : null;
    if (!url || !/artifactory/i.test(url)) {
      errors.push(`第 ${displayLine} 行：无有效外部 Artifactory http(s) 链接（ext_url / 转存地址）`);
      continue;
    }
    const picked = pickArtifactoryApiKeyForUrl(url, cfg);
    if (!picked) {
      errors.push(
        `第 ${displayLine} 行：无法匹配 API Key（请核对系统设置中内部/外部 Base URL 与 ext 链接主机是否一致）`,
      );
      continue;
    }
    const pathOnly = url.split(/[?#]/)[0] ?? url;
    const out = fileBasename(pathOnly);
    const cmd =
      tool === 'curl'
        ? buildCurlDownloadCommand(url, picked.apiKey, out)
        : buildWgetDownloadCommand(url, picked.apiKey, out);
    blocks.push(`# 第 ${displayLine} 行 · ext · ${picked.keyKind === 'ext' ? '外部' : '内部'} · ${out}`);
    blocks.push(cmd);
    blocks.push('');
  }
  return { text: blocks.join('\n').trimEnd(), errors };
}
