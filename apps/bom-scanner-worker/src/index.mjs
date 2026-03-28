import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v || !String(v).trim()) {
    throw new Error(`Missing required env: ${name}`);
  }
  return String(v).trim();
}

/** @param {string} filePath */
async function md5File(filePath) {
  const hash = createHash('md5');
  const stream = createReadStream(filePath);
  for await (const chunk of stream) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

/** @param {string} dir */
async function* walkFiles(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (e) {
    log('WARN readdir failed', dir, e instanceof Error ? e.message : e);
    return;
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      yield* walkFiles(full);
    } else if (ent.isFile()) {
      yield full;
    } else if (ent.isSymbolicLink()) {
      try {
        const st = await fs.stat(full);
        if (st.isFile()) yield full;
      } catch {
        /* skip broken symlink */
      }
    }
  }
}

function mtimeCloseEnough(dbIso, fileMtimeMs) {
  if (!dbIso) return false;
  const dbMs = Date.parse(dbIso);
  if (!Number.isFinite(dbMs)) return false;
  return Math.abs(dbMs - fileMtimeMs) < 2000;
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} relPath
 */
async function fetchLocalFileRow(supabase, relPath) {
  const { data, error } = await supabase
    .from('local_file')
    .select('size_bytes,mtime,md5')
    .eq('path', relPath)
    .maybeSingle();
  if (error) throw error;
  return data;
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 */
function clampScanSeconds(n) {
  if (!Number.isFinite(n)) return 30;
  return Math.min(86400, Math.max(5, Math.round(n)));
}

/**
 * 与 Web 设置一致：scanIntervalSeconds；兼容历史 scanIntervalMinutes
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 */
async function fetchScanIntervalSeconds(supabase) {
  const { data, error } = await supabase.from('system_settings').select('value').eq('key', 'bom_scanner').maybeSingle();
  if (error) {
    log('WARN fetch bom_scanner settings', error.message);
    return 30;
  }
  const v = data?.value;
  if (typeof v?.scanIntervalSeconds === 'number' && Number.isFinite(v.scanIntervalSeconds)) {
    return clampScanSeconds(v.scanIntervalSeconds);
  }
  if (typeof v?.scanIntervalMinutes === 'number' && Number.isFinite(v.scanIntervalMinutes)) {
    return clampScanSeconds(v.scanIntervalMinutes * 60);
  }
  return 30;
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 */
async function pickQueuedJob(supabase) {
  const { data, error } = await supabase
    .from('bom_scan_jobs')
    .select('id')
    .eq('status', 'queued')
    .order('requested_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data?.id ?? null;
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 */
async function hasActiveScanJob(supabase) {
  const { data, error } = await supabase
    .from('bom_scan_jobs')
    .select('id')
    .in('status', ['queued', 'running'])
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return Boolean(data?.id);
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 */
async function lastSucceededFinishedAt(supabase) {
  const { data, error } = await supabase
    .from('bom_scan_jobs')
    .select('finished_at')
    .eq('status', 'succeeded')
    .order('finished_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data?.finished_at ? Date.parse(String(data.finished_at)) : 0;
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} jobId
 * @param {string} rootAbs
 */
async function runScanJob(supabase, jobId, rootAbs) {
  let filesSeen = 0;
  let filesMd5Updated = 0;

  const { error: startErr } = await supabase.rpc('bom_mark_scan_started', {
    p_job_id: jobId,
    p_message: 'scanning',
  });
  if (startErr) throw startErr;

  for await (const abs of walkFiles(rootAbs)) {
    const rel = path.relative(rootAbs, abs).split(path.sep).join('/');
    if (!rel || rel.startsWith('..')) continue;

    let st;
    try {
      st = await fs.stat(abs);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;

    filesSeen += 1;
    const sizeBytes = st.size;
    const mtimeIso = new Date(st.mtimeMs).toISOString();

    const existing = await fetchLocalFileRow(supabase, rel);
    const sizeSame = existing && Number(existing.size_bytes) === sizeBytes;
    const mtimeSame = existing && mtimeCloseEnough(existing.mtime, st.mtimeMs);
    const needMd5 = !existing || !sizeSame || !mtimeSame;

    let md5Hex = null;
    if (needMd5) {
      try {
        md5Hex = await md5File(abs);
        filesMd5Updated += 1;
      } catch (e) {
        log('WARN md5 failed', rel, e instanceof Error ? e.message : e);
      }
    }

    const { error: upErr } = await supabase.rpc('bom_upsert_local_file', {
      p_job_id: jobId,
      p_path: rel,
      p_size_bytes: sizeBytes,
      p_mtime: mtimeIso,
      p_md5: md5Hex,
    });
    if (upErr) throw upErr;
  }

  const summary = `files_seen=${filesSeen} md5_updated=${filesMd5Updated}`;
  const { error: finErr } = await supabase.rpc('bom_finalize_scan', {
    p_job_id: jobId,
    p_success: true,
    p_files_seen: filesSeen,
    p_files_md5_updated: filesMd5Updated,
    p_files_removed: 0,
    p_message: summary,
    p_prune_missing: true,
  });
  if (finErr) throw finErr;
  log('job done', jobId, summary);
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} jobId
 * @param {string} message
 */
async function failJob(supabase, jobId, message) {
  const { error } = await supabase.rpc('bom_finalize_scan', {
    p_job_id: jobId,
    p_success: false,
    p_files_seen: 0,
    p_files_md5_updated: 0,
    p_files_removed: 0,
    p_message: message.slice(0, 2000),
    p_prune_missing: false,
  });
  if (error) log('WARN failJob finalize error', error.message);
}

async function main() {
  const url = requireEnv('SUPABASE_URL');
  const key = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  const root = requireEnv('BOM_LOCAL_ROOT');

  let rootAbs = path.resolve(root);
  try {
    await fs.access(rootAbs, fs.constants.R_OK);
  } catch (e) {
    throw new Error(`BOM_LOCAL_ROOT not readable: ${rootAbs} (${e instanceof Error ? e.message : e})`);
  }

  const supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  log('bom-scanner-worker start', { root: rootAbs, cwd: process.cwd(), note: 'interval from system_settings.bom_scanner.scanIntervalSeconds' });

  while (true) {
    let intervalSec = 30;
    try {
      intervalSec = await fetchScanIntervalSeconds(supabase);

      let jobId = await pickQueuedJob(supabase);
      while (jobId) {
        try {
          await runScanJob(supabase, jobId, rootAbs);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          log('ERROR job failed', jobId, msg);
          await failJob(supabase, jobId, msg);
        }
        jobId = await pickQueuedJob(supabase);
      }

      const active = await hasActiveScanJob(supabase);
      if (!active) {
        const lastOk = await lastSucceededFinishedAt(supabase);
        const due = lastOk === 0 || Date.now() - lastOk >= intervalSec * 1000;
        if (due) {
          const { data: newId, error: reqErr } = await supabase.rpc('bom_request_scan', { p_trigger_source: 'scheduler' });
          if (reqErr) log('WARN scheduler enqueue', reqErr.message);
          else log('scheduler enqueued', newId);
        }
      }
    } catch (e) {
      log('ERROR tick', e instanceof Error ? e.stack : e);
    }
    await sleep(intervalSec * 1000);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
