import { getArtifactoryApiInfo, type ApiInfoResult } from './artifactoryApi';
import type { ArtifactoryConfig } from './artifactorySettings';
import type { BomJsonKeyMap } from './bomScannerSettings';
import type { BomBatchRow } from './bomBatches';
import type { BomRowRecord } from './bomParser';
import {
  IT_STATUS_LEGACY_ARTIFACTORY_PREFIX,
  IT_STATUS_MD5_PREFIX,
  IT_STATUS_SIZE_PREFIX,
  mergeItFetchError,
  type BomRowStatusJson,
} from './bomRowStatus';
import {
  extractDownloadUrlRaw,
  extractHttpUrlFromDownloadCell,
  setRowFieldByAliases,
} from './bomRowFields';

const CHUNK = 20;

function isMd5ItMessage(p: string): boolean {
  const t = p.trim();
  return t.startsWith(IT_STATUS_MD5_PREFIX) || t.startsWith(IT_STATUS_LEGACY_ARTIFACTORY_PREFIX);
}

function isSizeItMessage(p: string): boolean {
  return p.trim().startsWith(IT_STATUS_SIZE_PREFIX);
}

/** 若 It 行已有补全 MD5 类说明，追加尺寸检查说明（否则覆盖为本次尺寸检查结果） */
function mergeSizeLineWithPreservedMd5(prevIt: string | null | undefined, sizeLine: string): string {
  const p = (prevIt ?? '').trim();
  if (isMd5ItMessage(p) && p) {
    return `${p}\n${sizeLine}`.slice(0, 1000);
  }
  return sizeLine.slice(0, 1000);
}

function nextStatusAfterSizeApi(
  status: BomRowStatusJson,
  res: ApiInfoResult,
  sizeWritten: boolean,
): BomRowStatusJson {
  const prev = status.it_fetch_error?.trim() ?? '';

  if (res.ok && res.info && sizeWritten) {
    if (isMd5ItMessage(prev)) return status;
    if (!prev || isSizeItMessage(prev)) {
      return mergeItFetchError(status, null);
    }
    return status;
  }

  const errText = res.error ?? `HTTP ${res.status ?? '错误'}`;
  const short = errText.length > 200 ? `${errText.slice(0, 197)}…` : errText;

  if (res.ok && res.info && !sizeWritten) {
    const line = `${IT_STATUS_SIZE_PREFIX} API 成功但未返回可用 size`;
    return mergeItFetchError(status, mergeSizeLineWithPreservedMd5(status.it_fetch_error, line));
  }

  const failLine = `${IT_STATUS_SIZE_PREFIX} 失败：${short}`.slice(0, 1000);
  return mergeItFetchError(status, mergeSizeLineWithPreservedMd5(status.it_fetch_error, failLine));
}

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
 * 通过 Artifactory Storage API 拉取 size 并写入 fileSizeBytes 别名列；
 * 结果写入 status.it_fetch_error（前缀 `[检查·远程大小]`）；不改动 MD5；若已有 `[补全·MD5]` 说明则在失败时追加一行。
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
        let sizeWritten = false;
        if (res.ok && res.info) {
          const sz = res.info.size;
          if (typeof sz === 'number' && Number.isFinite(sz) && sz >= 0) {
            nextRecord = setRowFieldByAliases(nextRecord, aliasesSize, String(Math.round(sz)));
            summary.sizeFilledCount += 1;
            sizeWritten = true;
          } else {
            summary.apiOkButNoSizeCount += 1;
          }
        } else {
          summary.apiRespondedErrorCount += 1;
        }
        const nextStatus = nextStatusAfterSizeApi(item.row.status, res, sizeWritten);
        outRows[item.index] = { ...item.row, bom_row: nextRecord, status: nextStatus };
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
        summary.apiRespondedErrorCount += 1;
        const nextStatus = nextStatusAfterSizeApi(item.row.status, res, false);
        outRows[item.index] = { ...item.row, bom_row: nextRecord, status: nextStatus };
      });
    }
  }

  return { rows: outRows, summary };
}
