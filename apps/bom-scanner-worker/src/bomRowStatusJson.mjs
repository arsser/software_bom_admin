/**
 * bom_rows.status 为 JSONB：local、ext 及可选 local_fetch_error、ext_fetch_error。
 */

/**
 * @param {unknown} s
 * @returns {Record<string, unknown>}
 */
export function normalizeBomRowStatus(s) {
  const raw =
    s && typeof s === 'object' && !Array.isArray(s) ? { .../** @type {Record<string, unknown>} */ (s) } : {};
  const local = typeof raw.local === 'string' ? raw.local : 'pending';
  const ext = typeof raw.ext === 'string' ? raw.ext : 'not_started';
  return { ...raw, local, ext };
}

/**
 * @param {unknown} current
 * @param {string} local
 */
export function withLocal(current, local) {
  return { ...normalizeBomRowStatus(current), local };
}

/**
 * @param {unknown} current
 * @param {string} ext
 */
export function withExt(current, ext) {
  return { ...normalizeBomRowStatus(current), ext };
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} rowId
 * @param {string} local
 * @param {string | null | undefined} localFetchError
 */
export async function patchBomRowLocalStatus(supabase, rowId, local, localFetchError) {
  const { data, error: selErr } = await supabase.from('bom_rows').select('status').eq('id', rowId).maybeSingle();
  if (selErr) {
    console.warn('WARN patchBomRowLocalStatus select', selErr.message);
    return;
  }
  let st = normalizeBomRowStatus(data?.status);
  st = { ...st, local };
  if (localFetchError !== undefined) {
    if (localFetchError === null || localFetchError === '') delete st.local_fetch_error;
    else st.local_fetch_error = String(localFetchError).slice(0, 1000);
  }
  const { error: upErr } = await supabase.from('bom_rows').update({ status: st }).eq('id', rowId);
  if (upErr) console.warn('WARN patchBomRowLocalStatus update', upErr.message);
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} rowId
 * @param {string} ext
 * @param {string | null | undefined} extFetchError
 */
export async function patchBomRowExtStatus(supabase, rowId, ext, extFetchError) {
  const { data, error: selErr } = await supabase.from('bom_rows').select('status').eq('id', rowId).maybeSingle();
  if (selErr) {
    console.warn('WARN patchBomRowExtStatus select', selErr.message);
    return;
  }
  let st = normalizeBomRowStatus(data?.status);
  st = { ...st, ext };
  if (extFetchError !== undefined) {
    if (extFetchError === null || extFetchError === '') delete st.ext_fetch_error;
    else st.ext_fetch_error = String(extFetchError).slice(0, 1000);
  }
  const { error: upErr } = await supabase.from('bom_rows').update({ status: st }).eq('id', rowId);
  if (upErr) console.warn('WARN patchBomRowExtStatus update', upErr.message);
}

const FEISHU_MP_KEYS = [
  'feishu_mp_upload_id',
  'feishu_mp_block_size',
  'feishu_mp_block_num',
  'feishu_mp_done_seqs',
  'feishu_mp_parent_token',
  'feishu_mp_file_name',
  'feishu_mp_file_size',
  'feishu_mp_started_at',
];

/**
 * @param {unknown} status  bom_rows.status JSONB
 * @returns {{ uploadId: string, blockSize: number, blockNum: number,
 *             doneSeqs: number[], parentToken: string, fileName: string,
 *             fileSize: number, startedAt: string } | null}
 */
export function extractFeishuMultipartState(status) {
  const st = status && typeof status === 'object' && !Array.isArray(status)
    ? /** @type {Record<string, unknown>} */ (status)
    : {};
  if (!st.feishu_mp_upload_id) return null;
  return {
    uploadId: String(st.feishu_mp_upload_id),
    blockSize: Number(st.feishu_mp_block_size) || 0,
    blockNum: Number(st.feishu_mp_block_num) || 0,
    doneSeqs: Array.isArray(st.feishu_mp_done_seqs)
      ? st.feishu_mp_done_seqs.filter((n) => typeof n === 'number')
      : [],
    parentToken: String(st.feishu_mp_parent_token || ''),
    fileName: String(st.feishu_mp_file_name || ''),
    fileSize: Number(st.feishu_mp_file_size) || 0,
    startedAt: String(st.feishu_mp_started_at || ''),
  };
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} rowId
 * @param {{ uploadId: string, blockSize: number, blockNum: number,
 *           doneSeqs: number[], parentToken: string, fileName: string,
 *           fileSize: number, startedAt: string }} mp
 */
export async function saveBomRowFeishuMultipartState(supabase, rowId, mp) {
  const { data, error: selErr } = await supabase.from('bom_rows').select('status').eq('id', rowId).maybeSingle();
  if (selErr) {
    console.warn('WARN saveBomRowFeishuMultipartState select', selErr.message);
    return;
  }
  const st = normalizeBomRowStatus(data?.status);
  const next = {
    ...st,
    feishu_mp_upload_id: mp.uploadId,
    feishu_mp_block_size: mp.blockSize,
    feishu_mp_block_num: mp.blockNum,
    feishu_mp_done_seqs: mp.doneSeqs,
    feishu_mp_parent_token: mp.parentToken,
    feishu_mp_file_name: mp.fileName,
    feishu_mp_file_size: mp.fileSize,
    feishu_mp_started_at: mp.startedAt,
  };
  const { error: upErr } = await supabase.from('bom_rows').update({ status: next }).eq('id', rowId);
  if (upErr) console.warn('WARN saveBomRowFeishuMultipartState update', upErr.message);
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} rowId
 */
export async function clearBomRowFeishuMultipartState(supabase, rowId) {
  const { data, error: selErr } = await supabase.from('bom_rows').select('status').eq('id', rowId).maybeSingle();
  if (selErr) {
    console.warn('WARN clearBomRowFeishuMultipartState select', selErr.message);
    return;
  }
  const st = normalizeBomRowStatus(data?.status);
  for (const k of FEISHU_MP_KEYS) delete st[k];
  const { error: upErr } = await supabase.from('bom_rows').update({ status: st }).eq('id', rowId);
  if (upErr) console.warn('WARN clearBomRowFeishuMultipartState update', upErr.message);
}

/**
 * 飞书 worker 上传成功后写回 status（与 Edge 扫描 present 口径一致）
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} rowId
 * @param {{ fileToken: string; fileName: string; sizeBytes: number }} p
 */
export async function patchBomRowFeishuAfterUpload(supabase, rowId, p) {
  const { data, error: selErr } = await supabase.from('bom_rows').select('status').eq('id', rowId).maybeSingle();
  if (selErr) {
    console.warn('WARN patchBomRowFeishuAfterUpload select', selErr.message);
    return;
  }
  const st = normalizeBomRowStatus(data?.status);
  const iso = new Date().toISOString();
  const next = {
    ...st,
    feishu: 'present',
    feishu_file_token: p.fileToken,
    feishu_file_name: p.fileName,
    feishu_size_bytes: p.sizeBytes,
    feishu_scanned_at: iso,
  };
  delete next.feishu_scan_error;
  for (const k of FEISHU_MP_KEYS) delete next[k];
  const { error: upErr } = await supabase.from('bom_rows').update({ status: next }).eq('id', rowId);
  if (upErr) console.warn('WARN patchBomRowFeishuAfterUpload update', upErr.message);
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} rowId
 * @param {string} message
 */
export async function patchBomRowFeishuUploadError(supabase, rowId, message) {
  const { data, error: selErr } = await supabase.from('bom_rows').select('status').eq('id', rowId).maybeSingle();
  if (selErr) {
    console.warn('WARN patchBomRowFeishuUploadError select', selErr.message);
    return;
  }
  const st = normalizeBomRowStatus(data?.status);
  const iso = new Date().toISOString();
  const next = {
    ...st,
    feishu: 'error',
    feishu_scanned_at: iso,
    feishu_scan_error: String(message ?? '').slice(0, 1000),
  };
  delete next.feishu_file_token;
  delete next.feishu_file_name;
  delete next.feishu_size_bytes;
  const { error: upErr } = await supabase.from('bom_rows').update({ status: next }).eq('id', rowId);
  if (upErr) console.warn('WARN patchBomRowFeishuUploadError update', upErr.message);
}
