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
