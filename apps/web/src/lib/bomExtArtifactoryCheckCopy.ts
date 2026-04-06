import { supabase } from './supabase';
import { formatFunctionsInvokeError } from './supabaseFunctionsInvokeError';

export type BomExtCheckCopyResult =
  | {
      ok: true;
      needPut: true;
      message?: string;
    }
  | {
      ok: true;
      needPut: false;
      ext_url: string;
      ext_sync_kind: 'copied' | 'uploaded';
      targetRel: string;
      copiedFrom?: { repo: string; path: string };
    }
  | {
      ok: false;
      error: string;
      status?: number;
    };

export async function checkCopyExtForBomRow(rowId: string): Promise<BomExtCheckCopyResult> {
  const { data, error } = await supabase.functions.invoke('bom-ext-artifactory-checkcopy', {
    body: { row_id: rowId },
  });
  if (error) {
    return { ok: false, error: await formatFunctionsInvokeError(error) };
  }
  return data as BomExtCheckCopyResult;
}

