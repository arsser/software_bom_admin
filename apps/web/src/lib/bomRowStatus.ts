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

/** 批次表格下方仅展示一次：与「待处理」状态对应的含义说明 */
export const BOM_STATUS_LEGEND_PENDING =
  '本地未找到：索引中尚无与此期望 MD5 一致的文件；将文件放入暂存目录并扫描后可恢复。';

/** 批次表格下方仅展示一次：与「校验通过」状态对应的含义说明 */
export const BOM_STATUS_LEGEND_VERIFIED_OK = '本地索引中已存在与期望 MD5 一致的内容。';
