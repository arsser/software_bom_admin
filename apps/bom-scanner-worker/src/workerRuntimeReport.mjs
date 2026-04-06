function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

/**
 * 将 worker 本地根目录、全局心跳时间与忙碌状态写入 system_settings.bom_scanner.runtime（仅展示用）。
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} rootAbs
 * @param {{ phase?: 'idle' | 'busy'; busyHint?: string | null }} [opts]
 */
export async function reportBomLocalRootRuntime(supabase, rootAbs, opts = {}) {
  const nowIso = new Date().toISOString();
  const phase = opts.phase === 'busy' ? 'busy' : 'idle';
  const hintRaw = opts.busyHint;
  const hint =
    typeof hintRaw === 'string' && hintRaw.trim() ? hintRaw.trim().slice(0, 120) : null;
  try {
    const { data, error } = await supabase
      .from('system_settings')
      .select('value')
      .eq('key', 'bom_scanner')
      .maybeSingle();
    if (error) {
      log('WARN read bom_scanner for runtime report', error.message);
      return;
    }

    const cur = data?.value && typeof data.value === 'object' ? data.value : {};
    const prevRt = cur?.runtime && typeof cur.runtime === 'object' ? cur.runtime : {};
    /** @type {Record<string, unknown>} */
    const nextRuntime = {
      ...prevRt,
      workerLocalRoot: rootAbs,
      workerReportedAt: nowIso,
      workerPhase: phase,
    };
    if (phase === 'busy' && hint) {
      nextRuntime.workerBusyHint = hint;
    } else {
      delete nextRuntime.workerBusyHint;
    }

    const next = {
      ...cur,
      runtime: nextRuntime,
    };

    const { error: upErr } = await supabase
      .from('system_settings')
      .upsert({ key: 'bom_scanner', value: next }, { onConflict: 'key' });
    if (upErr) log('WARN write bom_scanner runtime report', upErr.message);
  } catch (e) {
    log('WARN report bom local root runtime', e instanceof Error ? e.message : e);
  }
}
