import { downloadJobIsTerminal, type BomDownloadJob } from './bomDownloadJobs';
import { extSyncJobIsTerminal, type BomExtSyncJob } from './bomExtSyncJobs';

/** 未终态下载任务涉及的 BOM 行 id（与 DB 写入的 row_ids 一致；「全量」任务亦为当时 eligible 行的具体列表） */
export function activeDownloadJobRowIdSet(jobs: BomDownloadJob[]): Set<string> {
  const s = new Set<string>();
  for (const j of jobs) {
    if (downloadJobIsTerminal(j.status)) continue;
    for (const id of j.rowIds) s.add(id);
  }
  return s;
}

/** 未终态 ext 同步任务涉及的 BOM 行 id；含 running_row_id 以免与 row_ids 展示不同步 */
export function activeExtSyncJobRowIdSet(jobs: BomExtSyncJob[]): Set<string> {
  const s = new Set<string>();
  for (const j of jobs) {
    if (extSyncJobIsTerminal(j.status)) continue;
    for (const id of j.rowIds) s.add(id);
    if (j.runningRowId) s.add(j.runningRowId);
  }
  return s;
}
