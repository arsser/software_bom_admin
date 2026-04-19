import {
  mergeKeyMap,
  firstNonEmptyByKeysRelaxed,
  safeFlatFilename,
  safePathSegment,
} from './extArtifactorySync.mjs';
import { feishuApiFailDetail } from './feishuUpload.mjs';

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

const FEISHU_LIST_FOLDER_PAGE_SIZE = 50;

function safeTrim(s) {
  return String(s ?? '').trim();
}

function isValidMd5Hex(v) {
  return typeof v === 'string' && /^[a-f0-9]{32}$/i.test(v.trim());
}

/**
 * @param {Record<string, unknown>} bomRow
 * @param {ReturnType<typeof mergeKeyMap>} keyMap
 */
function extractExpectedMd5Lower(bomRow, keyMap) {
  const md5Raw = firstNonEmptyByKeysRelaxed(bomRow, keyMap.expectedMd5);
  const lower = md5Raw && isValidMd5Hex(md5Raw) ? md5Raw.trim().toLowerCase() : null;
  return lower;
}

/**
 * @param {Record<string, unknown>} bomRow
 * @param {ReturnType<typeof mergeKeyMap>} keyMap
 */
function resolveMiddleDirFromRow(bomRow, keyMap) {
  const mod = firstNonEmptyByKeysRelaxed(bomRow, keyMap.moduleName);
  if (mod) return safePathSegment(mod);
  const grp = firstNonEmptyByKeysRelaxed(bomRow, keyMap.groupSegment);
  if (grp) return safePathSegment(grp);
  return null;
}

function basenameFromStoragePath(p) {
  const t = String(p ?? '').trim().replace(/\\/g, '/');
  const parts = t.split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

function expectedRelKey(middleDir, fileName) {
  return middleDir ? `${middleDir}/${fileName}` : fileName;
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 */
async function loadFeishuAppCreds(supabase) {
  const envId = safeTrim(process.env.FEISHU_APP_ID);
  const envSecret = safeTrim(process.env.FEISHU_APP_SECRET);
  if (envId && envSecret) return { appId: envId, appSecret: envSecret };
  const { data, error } = await supabase.from('system_settings').select('value').eq('key', 'feishu_config').maybeSingle();
  if (error) {
    log('WARN load feishu_config', error.message);
    return { appId: '', appSecret: '' };
  }
  const v = data?.value && typeof data.value === 'object' ? /** @type {Record<string, unknown>} */ (data.value) : {};
  return {
    appId: typeof v.appId === 'string' ? v.appId.trim() : '',
    appSecret: typeof v.appSecret === 'string' ? String(v.appSecret).trim() : '',
  };
}

/**
 * @param {string} appId
 * @param {string} appSecret
 */
async function feishuTenantToken(appId, appSecret) {
  const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`飞书 token 响应非 JSON：${text.slice(0, 200)}`);
  }
  if (!res.ok || body.code !== 0 || !body.tenant_access_token) {
    throw new Error(feishuApiFailDetail('tenant_access_token', res.status, body, text));
  }
  return String(body.tenant_access_token);
}

/**
 * @param {string} accessToken
 * @param {string} folderToken
 * @param {string} [pageToken]
 */
async function listFolderPage(accessToken, folderToken, pageToken) {
  const u = new URL('https://open.feishu.cn/open-apis/drive/v1/files');
  u.searchParams.set('folder_token', folderToken);
  u.searchParams.set('page_size', String(FEISHU_LIST_FOLDER_PAGE_SIZE));
  if (pageToken) u.searchParams.set('page_token', pageToken);
  const res = await fetch(u.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`列出文件夹响应非 JSON：${text.slice(0, 200)}`);
  }
  if (!res.ok || body.code !== 0) {
    log('WARN feishu-scan list_folder failed', {
      page_size_sent: u.searchParams.get('page_size'),
      httpStatus: res.status,
      feishuCode: body?.code,
      msg: body?.msg,
    });
    throw new Error(feishuApiFailDetail('list_folder', res.status, body, text));
  }
  const files = Array.isArray(body.data?.files) ? body.data.files : [];
  return {
    files,
    has_more: body.data?.has_more,
    page_token: body.data?.next_page_token,
  };
}

/**
 * @param {string} accessToken
 * @param {string} folderToken
 */
async function listAllInFolder(accessToken, folderToken) {
  const out = [];
  let pageToken;
  do {
    const page = await listFolderPage(accessToken, folderToken, pageToken);
    out.push(...page.files);
    pageToken = page.has_more && page.page_token ? page.page_token : undefined;
  } while (pageToken);
  return out;
}

/**
 * @param {string} accessToken
 * @param {string} parentFolderToken
 * @param {string} name
 */
async function createDriveChildFolder(accessToken, parentFolderToken, name) {
  const res = await fetch('https://open.feishu.cn/open-apis/drive/v1/files/create_folder', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({ folder_token: parentFolderToken, name }),
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`创建文件夹响应非 JSON：${text.slice(0, 200)}`);
  }
  if (!res.ok || parsed.code !== 0) {
    throw new Error(feishuApiFailDetail('create_folder', res.status, parsed, text));
  }
  const token = parsed.data?.token;
  if (typeof token !== 'string' || !token.trim()) {
    throw new Error('创建成功但未返回子文件夹 token');
  }
  return { token: token.trim() };
}

/**
 * @param {unknown[]} items
 * @param {string} folderName
 */
function findChildFolderToken(items, folderName) {
  for (const it of items) {
    if (safeTrim(it?.type) !== 'folder') continue;
    if (safeTrim(it?.name) === folderName) {
      const tok = safeTrim(it?.token);
      if (tok) return tok;
    }
  }
  return null;
}

/**
 * @param {unknown} it
 */
function resolveFileToken(it) {
  const t = safeTrim(it?.type);
  if (t === 'file') return safeTrim(it?.token) || null;
  if (t === 'shortcut') {
    const si = it?.shortcut_info;
    const tt = safeTrim(si?.target_type);
    const tok = safeTrim(si?.target_token);
    if (tt === 'file' && tok) return tok;
  }
  return null;
}

/**
 * @param {string} accessToken
 * @param {string} folderToken
 * @param {string} prefix
 * @param {Map<string, { token: string; name: string }>} index
 */
async function buildFileIndexUnder(accessToken, folderToken, prefix, index) {
  const items = await listAllInFolder(accessToken, folderToken);
  for (const it of items) {
    const name = safeTrim(it?.name);
    if (!name) continue;
    const t = safeTrim(it?.type);
    const rel = prefix ? `${prefix}${name}` : name;
    if (t === 'folder') {
      const childToken = safeTrim(it?.token);
      if (!childToken) continue;
      await buildFileIndexUnder(accessToken, childToken, `${rel}/`, index);
      continue;
    }
    const fileTok = resolveFileToken(it);
    if (fileTok) {
      index.set(rel, { token: fileTok, name });
    }
  }
}

/**
 * @param {string} accessToken
 * @param {string} fileToken
 */
async function fetchDriveBinaryFileSize(accessToken, fileToken) {
  const url = `https://open.feishu.cn/open-apis/drive/v1/files/${encodeURIComponent(fileToken)}/download`;
  try {
    const headRes = await fetch(url, {
      method: 'HEAD',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (headRes.ok) {
      const cl = headRes.headers.get('content-length');
      if (cl) {
        const n = parseInt(cl, 10);
        if (Number.isFinite(n) && n > 0) return n;
      }
    }
  } catch {
    /* ignore */
  }
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Range: 'bytes=0-0',
      },
    });
    const cr = res.headers.get('content-range');
    if (cr) {
      const m = cr.match(/\/(\d+)\s*$/);
      if (m) {
        const n = Number(m[1]);
        if (Number.isFinite(n) && n >= 0) return n;
      }
    }
    if (res.ok) {
      const cl = res.headers.get('content-length');
      if (cl) {
        const n = parseInt(cl, 10);
        if (Number.isFinite(n) && n > 0) return n;
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * @param {string} accessToken
 * @param {string[]} tokens
 * @param {number} concurrency
 */
async function fetchSizesForFileTokens(accessToken, tokens, concurrency) {
  const uniq = [...new Set(tokens.map((t) => safeTrim(t)).filter(Boolean))];
  const out = new Map();
  let idx = 0;
  const workers = Math.min(Math.max(1, concurrency), uniq.length || 1);
  const run = async () => {
    for (;;) {
      const i = idx++;
      if (i >= uniq.length) return;
      const tok = uniq[i];
      const sz = await fetchDriveBinaryFileSize(accessToken, tok);
      if (sz != null) out.set(tok, sz);
    }
  };
  await Promise.all(new Array(workers).fill(0).map(() => run()));
  return out;
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} jobId
 * @param {Record<string, unknown>} patch
 */
async function patchScanJob(supabase, jobId, patch) {
  const { error } = await supabase
    .from('bom_feishu_scan_jobs')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', jobId);
  if (error) log('WARN patchScanJob', jobId, error.message);
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {{ id: string; batch_id: string; auto_create_version_folder: boolean }} job
 */
export async function executeFeishuScanJob(supabase, job) {
  const jobId = job.id;
  const batchId = job.batch_id;
  const autoCreateVersionFolder = Boolean(job.auto_create_version_folder);

  let rowsPresent = 0;
  let rowsAbsent = 0;
  let rowsError = 0;
  let lastMessage = '';
  let errDbOnAbsent = 0;
  let errLfQuery = 0;
  let errRowNoMd5 = 0;
  let errRowNoLocal = 0;
  let errFeishuSize = 0;
  let errBatchNoMd5Rows = 0;

  const failJob = async (msg) => {
    await supabase
      .from('bom_feishu_scan_jobs')
      .update({
        status: 'failed',
        finished_at: new Date().toISOString(),
        rows_present: rowsPresent,
        rows_absent: rowsAbsent,
        rows_error: rowsError,
        message: msg.slice(0, 2000),
        updated_at: new Date().toISOString(),
      })
      .eq('id', jobId);
  };

  try {
    const { data: batch, error: batchErr } = await supabase
      .from('bom_batches')
      .select('id,name,product_id')
      .eq('id', batchId)
      .maybeSingle();
    if (batchErr || !batch) {
      await failJob(batchErr?.message || '批次不存在');
      return;
    }

    const { data: scannerRow, error: scannerErr } = await supabase
      .from('system_settings')
      .select('value')
      .eq('key', 'bom_scanner')
      .maybeSingle();
    if (scannerErr) {
      await failJob(`读取 bom_scanner 失败：${scannerErr.message}`);
      return;
    }
    const scannerVal = (scannerRow?.value ?? {}) instanceof Object ? scannerRow.value : {};
    const keyMap = mergeKeyMap(scannerVal);

    const { data: productRow, error: productErr } = await supabase
      .from('products')
      .select('feishu_drive_root_folder_token')
      .eq('id', batch.product_id)
      .maybeSingle();
    if (productErr) {
      await failJob(`读取产品配置失败：${productErr.message}`);
      return;
    }
    const rootFolder = safeTrim(productRow?.feishu_drive_root_folder_token);
    if (!rootFolder) {
      await failJob('未配置飞书存储根目录 folder_token（产品分发配置）');
      return;
    }

    const { data: rowList, error: rowsErr } = await supabase
      .from('bom_rows')
      .select('id,bom_row,status')
      .eq('batch_id', batchId)
      .order('sort_order', { ascending: true });
    if (rowsErr) {
      await failJob(rowsErr.message);
      return;
    }
    const rows = rowList ?? [];

    const batchNameRaw = safeTrim(batch.name);
    const batchNameFallback = `batch-${batchId.replace(/-/g, '').slice(0, 8)}`;
    const batchDir = safePathSegment(batchNameRaw || batchNameFallback);

    await patchScanJob(supabase, jobId, {
      message: `扫描中：准备连接飞书…（版本目录「${batchDir}」）`,
      rows_total: rows.length,
    });

    const { appId, appSecret } = await loadFeishuAppCreds(supabase);
    if (!appId || !appSecret) {
      await failJob(
        '未配置飞书应用凭据：请在 worker 环境变量 FEISHU_APP_ID / FEISHU_APP_SECRET，或 system_settings.feishu_config 中配置。',
      );
      return;
    }

    const accessToken = await feishuTenantToken(appId, appSecret);
    const rootItems = await listAllInFolder(accessToken, rootFolder);
    let batchFolderToken = findChildFolderToken(rootItems, batchDir);
    if (batchFolderToken) {
      log('[feishu-scan-worker] job', jobId, 'version folder at root (existing):', batchDir);
    } else if (autoCreateVersionFolder) {
      log('[feishu-scan-worker] job', jobId, 'version folder missing, create_folder:', batchDir);
      try {
        const created = await createDriveChildFolder(accessToken, rootFolder, batchDir);
        batchFolderToken = created.token;
        log('[feishu-scan-worker] job', jobId, 'create_folder succeeded:', batchDir);
      } catch (createErr) {
        const createMsg = createErr instanceof Error ? createErr.message : String(createErr);
        log('[feishu-scan-worker] job', jobId, 'create_folder failed:', createMsg, 'relisting root…');
        const refreshed = await listAllInFolder(accessToken, rootFolder);
        batchFolderToken = findChildFolderToken(refreshed, batchDir);
        if (!batchFolderToken) {
          throw createErr instanceof Error ? createErr : new Error(String(createErr));
        }
        log('[feishu-scan-worker] job', jobId, 'version folder after relist (reuse existing):', batchDir);
      }
    } else {
      log('[feishu-scan-worker] job', jobId, 'version folder missing, autoCreate off:', batchDir);
    }

    if (!batchFolderToken) {
      lastMessage = `飞书根目录下未找到版本文件夹「${batchDir}」`;
      for (const r of rows) {
        const prev = r.status && typeof r.status === 'object' ? r.status : {};
        const next = {
          ...prev,
          feishu: 'absent',
          feishu_scanned_at: new Date().toISOString(),
          feishu_scan_error: lastMessage,
        };
        const { error: uerr } = await supabase.from('bom_rows').update({ status: next }).eq('id', r.id);
        if (uerr) {
          rowsError += 1;
          errDbOnAbsent += 1;
        } else rowsAbsent += 1;
      }
    } else {
      await patchScanJob(supabase, jobId, { message: '扫描中：正在列举飞书版本目录下的文件…' });
      const index = new Map();
      await buildFileIndexUnder(accessToken, batchFolderToken, '', index);

      const md5Needed = new Set();
      for (const r of rows) {
        const bomRow = r.bom_row && typeof r.bom_row === 'object' ? r.bom_row : {};
        const m = extractExpectedMd5Lower(bomRow, keyMap);
        if (m) md5Needed.add(m);
      }
      const md5Arr = [...md5Needed];
      const localByMd5 = new Map();
      if (md5Arr.length > 0) {
        const { data: lfRows, error: lfErr } = await supabase
          .from('local_file')
          .select('md5,path,size_bytes')
          .in('md5', md5Arr);
        if (lfErr) {
          lastMessage = `读取本地索引失败：${lfErr.message}`;
          for (const r of rows) {
            const prev = r.status && typeof r.status === 'object' ? r.status : {};
            const next = {
              ...prev,
              feishu: 'error',
              feishu_scanned_at: new Date().toISOString(),
              feishu_scan_error: lastMessage,
            };
            const { error: uerr } = await supabase.from('bom_rows').update({ status: next }).eq('id', r.id);
            if (!uerr) {
              rowsError += 1;
              errLfQuery += 1;
            }
          }
        } else {
          for (const row of lfRows ?? []) {
            const m = String(row.md5 ?? '').trim().toLowerCase();
            const p = String(row.path ?? '').trim();
            const szRaw = row.size_bytes;
            const sz = typeof szRaw === 'string' ? Number(szRaw) : Number(szRaw);
            if (/^[a-f0-9]{32}$/.test(m) && p && Number.isFinite(sz) && sz >= 0 && !localByMd5.has(m)) {
              localByMd5.set(m, { path: p, sizeBytes: Math.trunc(sz) });
            }
          }

          const tokensForSize = [...index.values()].map((h) => h.token).filter(Boolean);
          const sizeByToken = await fetchSizesForFileTokens(accessToken, tokensForSize, 10);

          let rowIdx = 0;
          for (const r of rows) {
            rowIdx += 1;
            if (rowIdx === 1 || rowIdx % 4 === 0) {
              await patchScanJob(supabase, jobId, {
                message: `扫描中：对账 ${rowIdx}/${rows.length} 行…`,
                rows_present: rowsPresent,
                rows_absent: rowsAbsent,
                rows_error: rowsError,
              });
            }

            const bomRow = r.bom_row && typeof r.bom_row === 'object' ? r.bom_row : {};
            const prev = r.status && typeof r.status === 'object' ? r.status : {};
            const iso = new Date().toISOString();

            const md5Lower = extractExpectedMd5Lower(bomRow, keyMap);
            if (!md5Lower) {
              rowsError += 1;
              errRowNoMd5 += 1;
              const next = {
                ...prev,
                feishu: 'error',
                feishu_scanned_at: iso,
                feishu_scan_error: 'BOM 行缺少合法期望 MD5，无法与本地索引对账',
              };
              delete next.feishu_file_token;
              delete next.feishu_file_name;
              delete next.feishu_size_bytes;
              await supabase.from('bom_rows').update({ status: next }).eq('id', r.id);
              continue;
            }

            const localHit = localByMd5.get(md5Lower);
            if (!localHit) {
              rowsError += 1;
              errRowNoLocal += 1;
              const next = {
                ...prev,
                feishu: 'error',
                feishu_scanned_at: iso,
                feishu_scan_error: '本地索引中无该 MD5，请先完成本地扫描后再对账飞书',
              };
              delete next.feishu_file_token;
              delete next.feishu_file_name;
              delete next.feishu_size_bytes;
              await supabase.from('bom_rows').update({ status: next }).eq('id', r.id);
              continue;
            }

            const localBaseName = safeFlatFilename(basenameFromStoragePath(localHit.path));
            const middleDir = resolveMiddleDirFromRow(bomRow, keyMap);
            const relKey = expectedRelKey(middleDir, localBaseName);
            const hit = index.get(relKey);

            if (!hit) {
              rowsAbsent += 1;
              const next = {
                ...prev,
                feishu: 'absent',
                feishu_scanned_at: iso,
                feishu_scan_error: `飞书未找到路径「${relKey}」（与外部 AF：版本目录/组件或分组/本地文件名）`,
              };
              delete next.feishu_file_token;
              delete next.feishu_file_name;
              delete next.feishu_size_bytes;
              await supabase.from('bom_rows').update({ status: next }).eq('id', r.id);
              continue;
            }

            const feishuSz = sizeByToken.get(hit.token) ?? null;
            const feishuNameNorm = safeFlatFilename(hit.name).normalize('NFKC');
            const localNameNorm = localBaseName.normalize('NFKC');
            const nameOk = feishuNameNorm === localNameNorm;
            const locSz = Number(localHit.sizeBytes);
            const sizeOk = feishuSz != null && Number.isFinite(locSz) && feishuSz === locSz;

            if (!nameOk) {
              rowsAbsent += 1;
              const next = {
                ...prev,
                feishu: 'absent',
                feishu_scanned_at: iso,
                feishu_file_token: hit.token,
                feishu_file_name: hit.name,
                feishu_size_bytes: feishuSz ?? undefined,
                feishu_scan_error: `文件名不一致：本地「${localBaseName}」，飞书「${hit.name}」`,
              };
              await supabase.from('bom_rows').update({ status: next }).eq('id', r.id);
              continue;
            }

            if (feishuSz == null) {
              rowsError += 1;
              errFeishuSize += 1;
              const next = {
                ...prev,
                feishu: 'error',
                feishu_scanned_at: iso,
                feishu_file_token: hit.token,
                feishu_file_name: hit.name,
                feishu_scan_error: '无法读取飞书文件字节数（HEAD/Range），请检查应用云文档下载权限',
              };
              delete next.feishu_size_bytes;
              await supabase.from('bom_rows').update({ status: next }).eq('id', r.id);
              continue;
            }

            if (!sizeOk) {
              rowsAbsent += 1;
              const next = {
                ...prev,
                feishu: 'absent',
                feishu_scanned_at: iso,
                feishu_file_token: hit.token,
                feishu_file_name: hit.name,
                feishu_size_bytes: feishuSz,
                feishu_scan_error: `字节数不一致：本地 ${localHit.sizeBytes}，飞书 ${feishuSz}`,
              };
              await supabase.from('bom_rows').update({ status: next }).eq('id', r.id);
              continue;
            }

            rowsPresent += 1;
            const next = {
              ...prev,
              feishu: 'present',
              feishu_file_token: hit.token,
              feishu_file_name: hit.name,
              feishu_size_bytes: feishuSz,
              feishu_scanned_at: iso,
            };
            delete next.feishu_scan_error;
            await supabase.from('bom_rows').update({ status: next }).eq('id', r.id);
          }

          const errParts = [];
          if (errRowNoMd5) errParts.push(`缺期望 MD5 ${errRowNoMd5} 行`);
          if (errRowNoLocal) errParts.push(`本地索引无该 MD5 ${errRowNoLocal} 行（需先做 BOM 本地扫描）`);
          if (errFeishuSize) errParts.push(`无法读飞书文件大小 ${errFeishuSize} 行（权限或接口）`);
          if (errLfQuery) errParts.push(`读 local_file 失败 ${errLfQuery} 行`);
          if (errDbOnAbsent) errParts.push(`写库失败 ${errDbOnAbsent} 行`);
          const errDetail = errParts.length > 0 ? ` ${errParts.join('；')}` : '';
          lastMessage =
            rowsError > 0
              ? `完成：与飞书完全一致 ${rowsPresent}，需上传或不一致 ${rowsAbsent}，无法对账 ${rowsError} 行（非崩溃；多为缺 MD5 / 未扫本地 / 读飞书大小失败）。${errDetail}`.trim()
              : `完成：与飞书完全一致 ${rowsPresent}，需上传或不一致 ${rowsAbsent}`;
        }
      } else {
        const noMd5Msg = '该版本无有效 MD5 行，无法与飞书对账（请先在 BOM 中配置并保存清单 MD5）';
        lastMessage = noMd5Msg;
        const iso = new Date().toISOString();
        for (const r of rows) {
          const prev = r.status && typeof r.status === 'object' ? r.status : {};
          const next = {
            ...prev,
            feishu: 'error',
            feishu_scanned_at: iso,
            feishu_scan_error: noMd5Msg,
          };
          delete next.feishu_file_token;
          delete next.feishu_file_name;
          delete next.feishu_size_bytes;
          const { error: uerr } = await supabase.from('bom_rows').update({ status: next }).eq('id', r.id);
          if (!uerr) {
            rowsError += 1;
            errBatchNoMd5Rows += 1;
          }
        }
        if (errBatchNoMd5Rows > 0) {
          lastMessage = `${noMd5Msg}（已标记 ${errBatchNoMd5Rows} 行）`;
        }
      }
    }

    await supabase
      .from('bom_feishu_scan_jobs')
      .update({
        status: 'succeeded',
        finished_at: new Date().toISOString(),
        rows_present: rowsPresent,
        rows_absent: rowsAbsent,
        rows_error: rowsError,
        message: lastMessage,
        updated_at: new Date().toISOString(),
      })
      .eq('id', jobId);

    log('[feishu-scan-worker] job done', jobId, lastMessage);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[feishu-scan-worker] job', jobId, msg);
    await failJob(msg);
  }
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 */
export async function drainFeishuScanJobs(supabase) {
  for (;;) {
    const { data, error } = await supabase.rpc('bom_claim_feishu_scan_job');
    if (error) {
      log('WARN bom_claim_feishu_scan_job', error.message);
      break;
    }
    const rows = Array.isArray(data) ? data : data ? [data] : [];
    const picked = rows[0];
    if (!picked?.id) break;
    const id = String(picked.id);
    const batchId = String(picked.batch_id);
    const autoCreate = Boolean(picked.auto_create_version_folder);
    try {
      await executeFeishuScanJob(supabase, { id, batch_id: batchId, auto_create_version_folder: autoCreate });
    } catch (e) {
      const msg = (e instanceof Error ? e.message : String(e)).slice(0, 2000);
      log('ERROR drainFeishuScanJobs execute', id, msg);
      await supabase
        .from('bom_feishu_scan_jobs')
        .update({
          status: 'failed',
          finished_at: new Date().toISOString(),
          message: msg,
          updated_at: new Date().toISOString(),
        })
        .eq('id', id);
    }
  }
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {number} staleSec
 */
export async function failStaleFeishuScanJobs(supabase, staleSec) {
  const sec = Number.isFinite(staleSec) && staleSec >= 300 ? Math.floor(staleSec) : 7200;
  const { data, error } = await supabase.rpc('bom_fail_stale_feishu_scan_jobs', { p_stale_seconds: sec });
  if (error) {
    log('WARN bom_fail_stale_feishu_scan_jobs', error.message);
    return 0;
  }
  const n = typeof data === 'number' ? data : Number(data);
  if (n > 0) log('bom_fail_stale_feishu_scan_jobs', n, 'cutoffSec=', sec);
  return n;
}
