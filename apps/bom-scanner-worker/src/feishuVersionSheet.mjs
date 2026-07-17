/**
 * 在飞书版本目录下生成「软件包清单」电子表格，便于用户下载（含去重复用前序版本的链接）。
 */

import {
  fetchBomScannerValue,
  fetchBatchProductDistributionSettings,
  firstNonEmptyByKeysRelaxed,
  mergeKeyMap,
  safeFlatFilename,
  safePathSegment,
} from './extArtifactorySync.mjs';
import {
  buildFeishuFileDownloadUrl,
  buildFeishuPackageRelPath,
  loadFeishuPackageManifest,
} from './feishuPackageManifest.mjs';

/** 版本目录下固定表格标题（覆盖更新时按此名查找并删除旧表） */
export const VERSION_PACKAGE_SHEET_TITLE = '软件包清单';

const FEISHU_LIST_FOLDER_PAGE_SIZE = 50;

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function safeTrim(s) {
  return String(s ?? '').trim();
}

/**
 * @param {string} op
 * @param {number} httpStatus
 * @param {Record<string, unknown>} parsed
 * @param {string} [rawText]
 */
function feishuApiFailDetail(op, httpStatus, parsed, rawText) {
  const code = parsed && 'code' in parsed ? parsed.code : undefined;
  const msg = typeof parsed?.msg === 'string' ? parsed.msg : '';
  const pieces = [String(op), `HTTP ${httpStatus}`];
  if (code !== undefined && code !== null && code !== '') pieces.push(`飞书code=${String(code)}`);
  if (msg) pieces.push(`msg=${msg}`);
  if (rawText && (!msg || /^field validation failed$/i.test(msg.trim()))) {
    pieces.push(`raw=${String(rawText).slice(0, 400)}`);
  }
  return pieces.join(' · ');
}

/** @param {unknown} v */
function isValidMd5Hex(v) {
  return typeof v === 'string' && /^[a-f0-9]{32}$/i.test(v.trim());
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
    throw new Error(feishuApiFailDetail('list_folder', res.status, body, text));
  }
  return {
    files: Array.isArray(body.data?.files) ? body.data.files : [],
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
 * @param {Array<{ name?: string, token?: string, type?: string }>} items
 * @param {string} folderName
 */
function findChildFolderToken(items, folderName) {
  const want = safeTrim(folderName).normalize('NFKC');
  if (!want) return null;
  for (const it of items) {
    if (safeTrim(it.type) !== 'folder') continue;
    if (safeTrim(it.name).normalize('NFKC') === want) {
      const tok = safeTrim(it.token);
      if (tok) return tok;
    }
  }
  return null;
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
  return token.trim();
}

/**
 * @param {string} accessToken
 * @param {string} rootFolderToken
 * @param {string[]} segmentNames
 */
async function ensureFolderPath(accessToken, rootFolderToken, segmentNames) {
  let cur = rootFolderToken;
  for (const seg of segmentNames) {
    if (!seg) continue;
    const items = await listAllInFolder(accessToken, cur);
    let next = findChildFolderToken(items, seg);
    if (!next) {
      next = await createDriveChildFolder(accessToken, cur, seg);
      log('feishu-version-sheet mkdir', { seg });
    }
    cur = next;
  }
  return cur;
}

/**
 * @param {string} accessToken
 * @param {string} fileToken
 * @param {string} nodeType
 */
async function deleteDriveNode(accessToken, fileToken, nodeType) {
  const u = new URL(`https://open.feishu.cn/open-apis/drive/v1/files/${encodeURIComponent(fileToken)}`);
  u.searchParams.set('type', nodeType);
  const res = await fetch(u.toString(), {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`删除节点响应非 JSON：${text.slice(0, 200)}`);
  }
  if (!res.ok || parsed.code !== 0) {
    throw new Error(feishuApiFailDetail('delete_file', res.status, parsed, text));
  }
}

/**
 * 删除版本目录下同名电子表格（type=sheet）。
 * @param {string} accessToken
 * @param {string} folderToken
 * @param {string} title
 */
async function removeSameNameSheetIfAny(accessToken, folderToken, title) {
  const items = await listAllInFolder(accessToken, folderToken);
  const want = safeTrim(title).normalize('NFKC');
  for (const it of items) {
    const t = safeTrim(it.type);
    if (t !== 'sheet' && t !== 'file') continue;
    const n = safeTrim(it.name).normalize('NFKC');
    if (n === want && it.token) {
      try {
        await deleteDriveNode(accessToken, safeTrim(it.token), t === 'sheet' ? 'sheet' : 'file');
        log('feishu-version-sheet removed old', { title, type: t });
      } catch (err) {
        log('WARN feishu-version-sheet delete old failed', err instanceof Error ? err.message : err);
      }
      break;
    }
  }
}

/**
 * @param {string} accessToken
 * @param {string} folderToken
 * @param {string} title
 */
async function createSpreadsheet(accessToken, folderToken, title) {
  const res = await fetch('https://open.feishu.cn/open-apis/sheets/v3/spreadsheets', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({ title, folder_token: folderToken }),
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`创建电子表格响应非 JSON：${text.slice(0, 300)}`);
  }
  if (!res.ok || parsed.code !== 0) {
    throw new Error(feishuApiFailDetail('create_spreadsheet', res.status, parsed, text));
  }
  const ss = parsed.data?.spreadsheet;
  const spreadsheetToken = safeTrim(ss?.spreadsheet_token);
  const url = safeTrim(ss?.url);
  if (!spreadsheetToken) throw new Error('创建电子表格成功但未返回 spreadsheet_token');
  return { spreadsheetToken, url };
}

/**
 * @param {string} accessToken
 * @param {string} spreadsheetToken
 */
async function queryFirstSheetId(accessToken, spreadsheetToken) {
  const res = await fetch(
    `https://open.feishu.cn/open-apis/sheets/v3/spreadsheets/${encodeURIComponent(spreadsheetToken)}/sheets/query`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`查询工作表响应非 JSON：${text.slice(0, 300)}`);
  }
  if (!res.ok || parsed.code !== 0) {
    throw new Error(feishuApiFailDetail('sheets_query', res.status, parsed, text));
  }
  const sheets = Array.isArray(parsed.data?.sheets) ? parsed.data.sheets : [];
  const first = sheets[0];
  const sheetId = safeTrim(first?.sheet_id);
  if (!sheetId) throw new Error('电子表格无可用工作表 sheet_id');
  return sheetId;
}

/**
 * @param {string} accessToken
 * @param {string} spreadsheetToken
 * @param {string} range
 * @param {unknown[][]} values
 */
async function putSheetValues(accessToken, spreadsheetToken, range, values) {
  const res = await fetch(
    `https://open.feishu.cn/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(spreadsheetToken)}/values`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({
        valueRange: { range, values },
      }),
    },
  );
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`写入表格响应非 JSON：${text.slice(0, 300)}`);
  }
  if (!res.ok || parsed.code !== 0) {
    throw new Error(feishuApiFailDetail('sheets_values_put', res.status, parsed, text));
  }
}

/**
 * @param {Record<string, unknown>} bomRow
 * @param {ReturnType<typeof mergeKeyMap>} keyMap
 */
function resolveMiddleDirFromRow(bomRow, keyMap) {
  const modSeg = firstNonEmptyByKeysRelaxed(bomRow, keyMap.module);
  if (modSeg) return safePathSegment(modSeg);
  const comp = firstNonEmptyByKeysRelaxed(bomRow, keyMap.component);
  if (comp) return safePathSegment(comp);
  return null;
}

/**
 * @param {unknown} status
 */
function readFeishuPresentMeta(status) {
  const st = status && typeof status === 'object' && !Array.isArray(status)
    ? /** @type {Record<string, unknown>} */ (status)
    : {};
  if (String(st.feishu ?? '') !== 'present') return null;
  const fileToken = safeTrim(st.feishu_file_token);
  if (!fileToken) return null;
  const fileName = safeFlatFilename(safeTrim(st.feishu_file_name) || 'unknown');
  const sizeRaw = st.feishu_size_bytes;
  const sizeBytes = typeof sizeRaw === 'string' ? Number(sizeRaw) : Number(sizeRaw);
  return {
    fileToken,
    fileName,
    sizeBytes: Number.isFinite(sizeBytes) && sizeBytes >= 0 ? Math.trunc(sizeBytes) : 0,
  };
}

/**
 * 根据当前批次已对齐飞书的行，在版本目录下覆盖生成「软件包清单」电子表格。
 *
 * @param {object} p
 * @param {string} p.accessToken
 * @param {string} p.rootFolderToken
 * @param {string} p.batchDir
 * @param {ReturnType<typeof mergeKeyMap>} p.keyMap
 * @param {Array<{ bom_row?: unknown, status?: unknown }>} p.rows
 * @param {Awaited<ReturnType<typeof loadFeishuPackageManifest>> | null} [p.packageManifest]
 * @returns {Promise<{ spreadsheetToken: string, url: string, rowCount: number }>}
 */
export async function generateVersionPackageSheet(p) {
  const { accessToken, rootFolderToken, batchDir, keyMap, rows, packageManifest } = p;
  const versionFolder = await ensureFolderPath(accessToken, rootFolderToken, [batchDir]);
  await removeSameNameSheetIfAny(accessToken, versionFolder, VERSION_PACKAGE_SHEET_TITLE);

  const header = ['序号', '模块/组件', '文件名', 'MD5', '大小(字节)', '下载链接', '说明'];
  /** @type {unknown[][]} */
  const values = [header];
  let seq = 0;

  for (const r of rows) {
    const meta = readFeishuPresentMeta(r.status);
    if (!meta) continue;
    const bomRow =
      r.bom_row && typeof r.bom_row === 'object' ? /** @type {Record<string, unknown>} */ (r.bom_row) : {};
    const md5Raw = firstNonEmptyByKeysRelaxed(bomRow, keyMap.expectedMd5);
    const md5 = md5Raw && isValidMd5Hex(md5Raw) ? md5Raw.trim().toLowerCase() : '';
    const middleDir = resolveMiddleDirFromRow(bomRow, keyMap);
    const expectedRel = buildFeishuPackageRelPath(
      middleDir ? [batchDir, middleDir] : [batchDir],
      meta.fileName,
    );
    const downloadUrl = buildFeishuFileDownloadUrl(meta.fileToken);
    const manifestHit =
      packageManifest && md5
        ? packageManifest.byFileName.get(meta.fileName.normalize('NFKC'))
        : null;
    let note = '本版本目录';
    if (manifestHit?.rel_path) {
      const mRel = manifestHit.rel_path.normalize('NFKC');
      if (mRel !== expectedRel.normalize('NFKC') && !mRel.startsWith(`${batchDir}/`)) {
        note = `复用前序：${mRel}`;
      } else if (mRel !== expectedRel.normalize('NFKC')) {
        note = `清单路径：${mRel}`;
      }
    }

    seq += 1;
    values.push([
      seq,
      middleDir || '',
      meta.fileName,
      md5 || '',
      meta.sizeBytes,
      downloadUrl
        ? { type: 'url', text: '下载', link: downloadUrl }
        : '',
      note,
    ]);
  }

  if (seq === 0) {
    throw new Error('当前版本没有 feishu=present 的行，无法生成软件包清单');
  }

  const { spreadsheetToken, url } = await createSpreadsheet(
    accessToken,
    versionFolder,
    VERSION_PACKAGE_SHEET_TITLE,
  );
  const sheetId = await queryFirstSheetId(accessToken, spreadsheetToken);
  const endRow = values.length;
  const range = `${sheetId}!A1:G${endRow}`;
  await putSheetValues(accessToken, spreadsheetToken, range, values);

  log('feishu-version-sheet generated', {
    batchDir,
    rowCount: seq,
    spreadsheetToken: spreadsheetToken.slice(0, 12),
  });
  return { spreadsheetToken, url, rowCount: seq };
}

/**
 * 从 DB 加载批次 present 行并生成版本清单表。
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} accessToken
 * @param {string} batchId
 * @param {{ packageManifest?: Awaited<ReturnType<typeof loadFeishuPackageManifest>> | null }} [opts]
 */
export async function generateVersionPackageSheetForBatch(supabase, accessToken, batchId, opts = {}) {
  const scannerVal = await fetchBomScannerValue(supabase);
  const keyMap = mergeKeyMap(scannerVal);
  const batchProdCfg = await fetchBatchProductDistributionSettings(supabase, batchId);
  const rootFolder = safeTrim(batchProdCfg.feishuDriveRootFolderToken);
  if (!rootFolder) throw new Error('未配置飞书云盘根目录 folder_token');

  const batchNameRaw = batchProdCfg.batchName;
  const batchNameFallback = `batch-${String(batchId).replace(/-/g, '').slice(0, 8)}`;
  const batchDir = safePathSegment(batchNameRaw || batchNameFallback);

  const { data: rowList, error: rowsErr } = await supabase
    .from('bom_rows')
    .select('id,bom_row,status')
    .eq('batch_id', batchId)
    .order('sort_order', { ascending: true });
  if (rowsErr) throw new Error(`读取 BOM 行失败：${rowsErr.message}`);

  let packageManifest = opts.packageManifest;
  if (packageManifest === undefined) {
    try {
      packageManifest = await loadFeishuPackageManifest(accessToken, rootFolder);
    } catch (e) {
      log('WARN load manifest for version sheet', e instanceof Error ? e.message : e);
      packageManifest = null;
    }
  } else if (packageManifest === null) {
    packageManifest = null;
  }

  return generateVersionPackageSheet({
    accessToken,
    rootFolderToken: rootFolder,
    batchDir,
    keyMap,
    rows: rowList ?? [],
    packageManifest,
  });
}
