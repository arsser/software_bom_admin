/** 与 public.bom_row_status 枚举一致（迁移 20250327120000_bom_phase0） */
export type BomRowStatus =
  | 'pending'
  | 'await_manual_download'
  | 'local_found'
  | 'verified_ok'
  | 'verified_fail'
  | 'synced_or_skipped'
  | 'error';

export const BOM_ROW_STATUS_LABEL: Record<BomRowStatus, string> = {
  pending: '待处理',
  await_manual_download: '待人工下载',
  local_found: '本地已发现',
  verified_ok: '校验通过',
  verified_fail: '校验失败',
  synced_or_skipped: '已转存（或跳过）',
  error: '异常',
};

export const BOM_ROW_STATUS_ORDER: BomRowStatus[] = [
  'pending',
  'await_manual_download',
  'local_found',
  'verified_ok',
  'verified_fail',
  'synced_or_skipped',
  'error',
];

export function isBomRowStatus(v: string): v is BomRowStatus {
  return v in BOM_ROW_STATUS_LABEL;
}
