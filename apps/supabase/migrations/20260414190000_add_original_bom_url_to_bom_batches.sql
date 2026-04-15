alter table public.bom_batches
  add column if not exists original_bom_url text not null default '';

comment on column public.bom_batches.original_bom_url is
  '原始 BOM 页面链接（可选），用于在版本列表中快速跳转';
