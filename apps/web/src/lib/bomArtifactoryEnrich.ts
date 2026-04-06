import { getArtifactoryApiInfo, type ApiInfoResult } from './artifactoryApi';
import type { ArtifactoryConfig } from './artifactorySettings';
import type { BomJsonKeyMap } from './bomScannerSettings';
import type { BomBatchRow } from './bomBatches';
import { mergeLocalFetchError } from './bomRowStatus';
import {
  extractDownloadUrlRaw,
  extractExpectedMd5FromRow,
  extractHttpUrlFromDownloadCell,
  setRowFieldByAliases,
} from './bomRowFields';

const CHUNK = 20;

const ARTIFACTORY_FETCH_ERR_PREFIX = 'Artifactory：';

function nextLastFetchAfterEnrich(
  prev: string | null | undefined,
  res: ApiInfoResult,
): string | null {
  if (res.ok && res.info) {
    const p = (prev ?? '').trim();
    return p.startsWith(ARTIFACTORY_FETCH_ERR_PREFIX) ? null : prev ?? null;
  }
  const err = res.error ?? `HTTP ${res.status ?? '错误'}`;
  const short = err.length > 200 ? `${err.slice(0, 197)}…` : err;
  return `${ARTIFACTORY_FETCH_ERR_PREFIX}${short}`.slice(0, 1000);
}

function applyApiResultToRow(
  row: Record<string, string>,
  keyMap: BomJsonKeyMap,
  res: ApiInfoResult,
  prevFetchError: string | null | undefined,
): { bom_row: Record<string, string>; lastFetchError: string | null } {
  let next: Record<string, string> = { ...row };
  const aliasesMd5 = keyMap.expectedMd5;
  const aliasesSize = keyMap.fileSizeBytes ?? ['文件大小'];

  if (res.ok && res.info) {
    const md5 = res.info.checksums?.md5 ?? res.info.originalChecksums?.md5;
    if (md5 && /^[a-fA-F0-9]{32}$/.test(md5.trim())) {
      next = setRowFieldByAliases(next, aliasesMd5, md5.trim().toLowerCase());
    }
    if (typeof res.info.size === 'number' && Number.isFinite(res.info.size) && res.info.size >= 0) {
      next = setRowFieldByAliases(next, aliasesSize, String(Math.round(res.info.size)));
    }
    return { bom_row: next, lastFetchError: nextLastFetchAfterEnrich(prevFetchError, res) };
  }

  return { bom_row: next, lastFetchError: nextLastFetchAfterEnrich(prevFetchError, res) };
}

export type EnrichArtifactorySummary = {
  /** 有 http(s) 下载路径并参与 API 的行数 */
  rowsWithDownloadUrl: number;
  skippedNoUrl: number;
  failedChunks: number;
  /** 本次调用后新写入合法 MD5 的行数 */
  md5FilledCount: number;
  /** Storage API 返回 ok=false 的行数（原因写入 status.local_fetch_error / 状态说明·本地） */
  apiRespondedErrorCount: number;
  /** API 成功但未返回可用 MD5 校验和的行数 */
  apiOkButNoMd5Count: number;
  /** 整批请求抛错时的错误信息（与 failedChunks 对应） */
  chunkErrorMessages: string[];
};

/**
 * 对版本内各行：用下载路径请求 Storage API，将 MD5、大小写入 jsonb；
 * 失败将摘要写入 status.local_fetch_error（页面「状态说明·本地」）；成功时若原错误为本功能写入的 Artifactory 前缀则清空。
 * 不修改 jsonKeyMap.remark（原始粘贴备注列）。
 */
export async function enrichBomRowsFromArtifactory(
  rows: BomBatchRow[],
  keyMap: BomJsonKeyMap,
  _artifactory: ArtifactoryConfig,
): Promise<{ rows: BomBatchRow[]; summary: EnrichArtifactorySummary }> {
  const indexed: { row: BomBatchRow; url: string; index: number }[] = [];
  rows.forEach((row, index) => {
    const raw = extractDownloadUrlRaw(row.bom_row, keyMap);
    if (!raw) return;
    const url = extractHttpUrlFromDownloadCell(raw);
    if (!url) return;
    indexed.push({ row, url, index });
  });

  const summary: EnrichArtifactorySummary = {
    rowsWithDownloadUrl: indexed.length,
    skippedNoUrl: rows.length - indexed.length,
    failedChunks: 0,
    md5FilledCount: 0,
    apiRespondedErrorCount: 0,
    apiOkButNoMd5Count: 0,
    chunkErrorMessages: [],
  };

  if (indexed.length === 0) {
    return { rows, summary };
  }

  const outRows = [...rows];
  for (let i = 0; i < indexed.length; i += CHUNK) {
    const slice = indexed.slice(i, i + CHUNK);
    const urls = slice.map((s) => s.url);
    try {
      const results = await getArtifactoryApiInfo({ urls });

      slice.forEach((item, j) => {
        const res = results[j] ?? { url: item.url, ok: false, error: '无返回' };
        const beforeMd5 = extractExpectedMd5FromRow(item.row.bom_row, keyMap);
        const { bom_row: newBomRow, lastFetchError } = applyApiResultToRow(
          item.row.bom_row,
          keyMap,
          res,
          item.row.status.local_fetch_error,
        );
        const afterMd5 = extractExpectedMd5FromRow(newBomRow, keyMap);
        if (!res.ok) {
          summary.apiRespondedErrorCount += 1;
        } else if (!beforeMd5 && afterMd5) {
          summary.md5FilledCount += 1;
        } else if (res.ok && !afterMd5) {
          summary.apiOkButNoMd5Count += 1;
        }
        outRows[item.index] = {
          ...item.row,
          bom_row: newBomRow,
          status: mergeLocalFetchError(item.row.status, lastFetchError),
        };
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      summary.failedChunks += 1;
      if (!summary.chunkErrorMessages.includes(msg)) {
        summary.chunkErrorMessages.push(msg);
      }
      slice.forEach((item) => {
        const res: ApiInfoResult = { url: item.url, ok: false, error: msg };
        const { bom_row: newBomRow, lastFetchError } = applyApiResultToRow(
          item.row.bom_row,
          keyMap,
          res,
          item.row.status.local_fetch_error,
        );
        summary.apiRespondedErrorCount += 1;
        outRows[item.index] = {
          ...item.row,
          bom_row: newBomRow,
          status: mergeLocalFetchError(item.row.status, lastFetchError),
        };
      });
    }
  }

  return { rows: outRows, summary };
}
