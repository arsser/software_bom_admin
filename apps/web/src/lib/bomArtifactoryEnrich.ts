import { getArtifactoryApiInfo, type ApiInfoResult } from './artifactoryApi';
import type { ArtifactoryConfig } from './artifactorySettings';
import type { BomJsonKeyMap } from './bomScannerSettings';
import type { BomBatchRow } from './bomBatches';
import {
  extractDownloadUrlRaw,
  extractHttpUrlFromDownloadCell,
  setRowFieldByAliases,
} from './bomRowFields';

const CHUNK = 20;

function applyApiResultToRow(
  row: Record<string, string>,
  keyMap: BomJsonKeyMap,
  res: ApiInfoResult,
): Record<string, string> {
  let next: Record<string, string> = { ...row };
  const aliasesMd5 = keyMap.expectedMd5;
  const aliasesSize = keyMap.fileSizeBytes ?? ['文件大小'];
  const aliasesRemark = keyMap.remark ?? ['备注'];

  if (res.ok && res.info) {
    const md5 = res.info.checksums?.md5 ?? res.info.originalChecksums?.md5;
    if (md5 && /^[a-fA-F0-9]{32}$/.test(md5.trim())) {
      next = setRowFieldByAliases(next, aliasesMd5, md5.trim().toLowerCase());
    }
    if (typeof res.info.size === 'number' && Number.isFinite(res.info.size) && res.info.size >= 0) {
      next = setRowFieldByAliases(next, aliasesSize, String(Math.round(res.info.size)));
    }
    next = setRowFieldByAliases(next, aliasesRemark, '');
    return next;
  }

  const err = res.error ?? `HTTP ${res.status ?? '错误'}`;
  const short = err.length > 200 ? `${err.slice(0, 197)}…` : err;
  next = setRowFieldByAliases(next, aliasesRemark, `Artifactory：${short}`);
  return next;
}

export type EnrichArtifactorySummary = {
  /** 有 http(s) 下载路径并参与 API 的行数 */
  rowsWithDownloadUrl: number;
  skippedNoUrl: number;
  failedChunks: number;
};

/**
 * 对批次内各行：用下载路径请求 Storage API，将 MD5、大小写入 jsonb，失败写入备注。
 */
export async function enrichBomRowsFromArtifactory(
  rows: BomBatchRow[],
  keyMap: BomJsonKeyMap,
  artifactory: ArtifactoryConfig,
): Promise<{ rows: BomBatchRow[]; summary: EnrichArtifactorySummary }> {
  const hasKey = Boolean(
    (artifactory.artifactoryApiKey || artifactory.artifactoryExtApiKey || '').trim(),
  );
  if (!hasKey) {
    throw new Error('请先在系统设置中配置 Artifactory API Key（it 或 ext 至少一个）');
  }

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
  };

  if (indexed.length === 0) {
    return { rows, summary };
  }

  const outRows = [...rows];
  const cfg: ArtifactoryConfig = artifactory;

  for (let i = 0; i < indexed.length; i += CHUNK) {
    const slice = indexed.slice(i, i + CHUNK);
    const urls = slice.map((s) => s.url);
    try {
      const results = await getArtifactoryApiInfo({
        urls,
        apiKey: artifactory.artifactoryApiKey || artifactory.artifactoryExtApiKey || undefined,
        config: {
          artifactoryBaseUrl: cfg.artifactoryBaseUrl || undefined,
          artifactoryApiKey: cfg.artifactoryApiKey || undefined,
          artifactoryExtBaseUrl: cfg.artifactoryExtBaseUrl || undefined,
          artifactoryExtApiKey: cfg.artifactoryExtApiKey || undefined,
        },
      });

      slice.forEach((item, j) => {
        const res = results[j] ?? { url: item.url, ok: false, error: '无返回' };
        const newBomRow = applyApiResultToRow(item.row.bom_row, keyMap, res);
        outRows[item.index] = { ...item.row, bom_row: newBomRow };
      });
    } catch {
      summary.failedChunks += 1;
      slice.forEach((item) => {
        const res: ApiInfoResult = { url: item.url, ok: false, error: '批量请求失败' };
        const newBomRow = applyApiResultToRow(item.row.bom_row, keyMap, res);
        outRows[item.index] = { ...item.row, bom_row: newBomRow };
      });
    }
  }

  return { rows: outRows, summary };
}
