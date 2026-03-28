import { supabase } from './supabase';

/** PostgREST / Supabase 返回的 error 多为普通对象，直接 String 会得到 [object Object] */
export function formatSupabaseError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object') {
    const o = err as Record<string, unknown>;
    const message = typeof o.message === 'string' ? o.message : '';
    const code = typeof o.code === 'string' ? o.code : '';
    const details = typeof o.details === 'string' ? o.details : '';
    const hint = typeof o.hint === 'string' ? o.hint : '';
    const parts = [code && `code=${code}`, message, details, hint].filter(Boolean);
    if (parts.length) return parts.join(' — ');
  }
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export type BomScanJobStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export type BomScanJob = {
  id: string;
  status: BomScanJobStatus;
  triggerSource: string;
  message: string | null;
  filesSeen: number;
  filesMd5Updated: number;
  filesRemoved: number;
  requestedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

function mapJob(raw: any): BomScanJob {
  return {
    id: String(raw.id),
    status: raw.status as BomScanJobStatus,
    triggerSource: String(raw.trigger_source ?? 'manual'),
    message: raw.message ? String(raw.message) : null,
    filesSeen: Number(raw.files_seen ?? 0),
    filesMd5Updated: Number(raw.files_md5_updated ?? 0),
    filesRemoved: Number(raw.files_removed ?? 0),
    requestedAt: String(raw.requested_at),
    startedAt: raw.started_at ? String(raw.started_at) : null,
    finishedAt: raw.finished_at ? String(raw.finished_at) : null,
  };
}

export async function requestBomScan(triggerSource = 'manual'): Promise<string> {
  const { data, error } = await supabase.rpc('bom_request_scan', { p_trigger_source: triggerSource });
  if (error) throw new Error(formatSupabaseError(error));
  if (data == null) throw new Error('bom_request_scan 未返回任务 ID（请确认已执行迁移 20250327143000_bom_phase2_scanner_jobs）');
  return String(data);
}

export async function fetchLatestBomScanJob(): Promise<BomScanJob | null> {
  const { data, error } = await supabase
    .from('bom_scan_jobs')
    .select('id,status,trigger_source,message,files_seen,files_md5_updated,files_removed,requested_at,started_at,finished_at')
    .order('requested_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error && error.code !== 'PGRST116') throw error;
  if (!data) return null;
  return mapJob(data);
}

export async function fetchLocalFileStats(): Promise<{ fileCount: number; md5Count: number }> {
  const { count: fileCount, error: fileCountError } = await supabase
    .from('local_file')
    .select('path', { count: 'exact', head: true });
  if (fileCountError) throw fileCountError;

  const { data, error } = await supabase
    .from('local_file')
    .select('md5')
    .not('md5', 'is', null);
  if (error) throw error;

  const md5Count = new Set((data ?? []).map((x: any) => String(x.md5).toLowerCase()).filter((x) => /^[a-f0-9]{32}$/.test(x))).size;
  return { fileCount: Number(fileCount ?? 0), md5Count };
}
