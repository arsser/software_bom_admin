import { getArtifactoryApiInfo, type ApiInfoResult } from './artifactoryApi';
import type { ArtifactoryConfig } from './artifactorySettings';
import type { BomJsonKeyMap } from './bomScannerSettings';
import type { BomBatchRow } from './bomBatches';
import type { BomRowRecord } from './bomParser';
import {
  extractDownloadUrlRaw,
  extractHttpUrlFromDownloadCell,
  setRowFieldByAliases,
} from './bomRowFields';

const CHUNK = 20;

export type RemoteArtifactorySizeSummary = {
  rowsWithArtifactoryUrl: number;
  skippedNoUrl: number;
  sizeFilledCount: number;
  apiRespondedErrorCount: number;
  apiOkButNoSizeCount: number;
  failedChunks: number;
  chunkErrorMessages: string[];
};

/**
 * 仅通过 it-Artifactory Storage API 拉取 size 并写入 jsonKeyMap.fileSizeBytes 别名列（不改动 MD5 / status）。
 */
export async function enrichBomRowsRemoteSizeFromArtifactory(
  rows: BomBatchRow[],
  keyMap: BomJsonKeyMap,
  _artifactory: ArtifactoryConfig,
): Promise<{ rows: BomBatchRow[]; summary: RemoteArtifactorySizeSummary }> {
  const aliasesSize = keyMap.fileSizeBytes?.length ? keyMap.fileSizeBytes : ['文件大小'];
  const indexed: { row: BomBatchRow; url: string; index: number }[] = [];
  rows.forEach((row, index) => {
    const raw = extractDownloadUrlRaw(row.bom_row, keyMap);
    if (!raw) return;
    const url = extractHttpUrlFromDownloadCell(raw);
    if (!url) return;
    if (!/artifactory/i.test(url)) return;
    indexed.push({ row, url, index });
  });

  const summary: RemoteArtifactorySizeSummary = {
    rowsWithArtifactoryUrl: indexed.length,
    skippedNoUrl: rows.length - indexed.length,
    sizeFilledCount: 0,
    apiRespondedErrorCount: 0,
    apiOkButNoSizeCount: 0,
    failedChunks: 0,
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
        const res = results[j] ?? ({ url: item.url, ok: false, error: '无返回' } satisfies ApiInfoResult);
        let nextRecord: BomRowRecord = { ...item.row.bom_row };
        if (res.ok && res.info) {
          const sz = res.info.size;
          if (typeof sz === 'number' && Number.isFinite(sz) && sz >= 0) {
            nextRecord = setRowFieldByAliases(nextRecord, aliasesSize, String(Math.round(sz)));
            summary.sizeFilledCount += 1;
          } else {
            summary.apiOkButNoSizeCount += 1;
          }
        } else {
          summary.apiRespondedErrorCount += 1;
        }
        outRows[item.index] = { ...item.row, bom_row: nextRecord };
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      summary.failedChunks += 1;
      if (!summary.chunkErrorMessages.includes(msg)) {
        summary.chunkErrorMessages.push(msg);
      }
      slice.forEach((item) => {
        const res: ApiInfoResult = { url: item.url, ok: false, error: msg };
        let nextRecord: BomRowRecord = { ...item.row.bom_row };
        if (!res.ok) summary.apiRespondedErrorCount += 1;
        outRows[item.index] = { ...item.row, bom_row: nextRecord };
      });
    }
  }

  return { rows: outRows, summary };
}
