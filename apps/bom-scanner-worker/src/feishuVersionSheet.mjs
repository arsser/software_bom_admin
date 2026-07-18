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
  buildFeishuPackageRelPath,
  loadFeishuPackageManifest,
  resolvePackageManifestDownloadUrl,
} from './feishuPackageManifest.mjs';

/** 版本目录 BOM 表标题后缀：完整名为 `{产品}-{版本}-软件包清单` */
export const VERSION_PACKAGE_SHEET_TITLE_SUFFIX = '软件包清单';

/**
 * @param {string} productName
 * @param {string} versionName 版本目录名 / 批次名
 */
export function buildVersionPackageSheetTitle(productName, versionName) {
  const p = safePathSegment(productName || 'product');
  const v = safePathSegment(versionName || 'version');
  const title = `${p}-${v}-${VERSION_PACKAGE_SHEET_TITLE_SUFFIX}`;
  // 飞书标题过长时截断，保留后缀可识别
  if (title.length <= 100) return title;
  const suffix = `-${VERSION_PACKAGE_SHEET_TITLE_SUFFIX}`;
  const budget = Math.max(8, 100 - suffix.length);
  return `${title.slice(0, budget)}${suffix}`;
}

/** @deprecated 仅兼容旧文案；实际表名请用 buildVersionPackageSheetTitle */
export const VERSION_PACKAGE_SHEET_TITLE = VERSION_PACKAGE_SHEET_TITLE_SUFFIX;

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

/** 飞书版本 BOM 表默认列顺序（与 web bomScannerSettings.DEFAULT_VERSION_SHEET_COLUMNS 一致） */
export const DEFAULT_VERSION_SHEET_COLUMNS = [
  '模块',
  '组件ID',
  '版本号',
  '组件名',
  '组件类型',
  '文件大小',
  '相对路径',
  '下载链接',
  '上传时间',
  'MD5',
  '硬件平台',
  'ext_url',
  '备注',
];

const FEISHU_VALUES_MAX_COLS = 100;

/**
 * @param {unknown} raw
 * @returns {string[]}
 */
export function normalizeVersionSheetColumns(raw) {
  if (!Array.isArray(raw)) return [...DEFAULT_VERSION_SHEET_COLUMNS];
  const cols = raw
    .map((x) => safeTrim(x))
    .filter(Boolean)
    .slice(0, FEISHU_VALUES_MAX_COLS);
  return cols.length > 0 ? cols : [...DEFAULT_VERSION_SHEET_COLUMNS];
}

/**
 * @param {string} header
 * @returns {'size'|'rel_path'|'download_url'|'uploaded_at'|null}
 */
function extraColumnKind(header) {
  const h = safeTrim(header).normalize('NFKC');
  if (h === '文件大小') return 'size';
  if (h === '相对路径') return 'rel_path';
  if (h === '下载链接' || h === '下载地址') return 'download_url';
  if (h === '上传时间') return 'uploaded_at';
  return null;
}

/**
 * 按表头从 bom_row 取值（优先 jsonKeyMap，再按常见别名）。
 * @param {Record<string, unknown>} bomRow
 * @param {ReturnType<typeof mergeKeyMap> & Record<string, string[]|undefined>} keyMap
 * @param {string} header
 */
function resolveBomCellByHeader(bomRow, keyMap, header) {
  const h = safeTrim(header).normalize('NFKC');
  if (!h) return '';
  /** @type {Record<string, string[]>} */
  const byHeader = {
    模块: [...(keyMap.module || []), '模块', '分组', 'group', 'groupName', '组别'],
    组件ID: ['组件ID', 'componentId', 'component_id'],
    版本号: [...(keyMap.releaseVersion || []), '版本号', '版本', 'version', 'releaseVersion', '产品版本'],
    组件名: [...(keyMap.component || []), '组件名', '组件', 'Component'],
    组件类型: ['组件类型', 'componentType', 'component_type', '类型'],
    MD5: [...(keyMap.expectedMd5 || []), 'MD5', 'md5', 'checksum'],
    硬件平台: [...(keyMap.arch || []), '硬件平台', 'arch', 'platform', '架构'],
    ext_url: [...(keyMap.extUrl || []), 'ext_url', 'extUrl', '转存地址'],
    备注: [...(keyMap.remark || []), '备注', 'note', 'remark'],
  };
  const keys = byHeader[h] || [h];
  const v = firstNonEmptyByKeysRelaxed(bomRow, keys);
  return v != null ? v : '';
}

/**
 * 0-based 列索引 → Excel/飞书列字母（A, B, …, Z, AA, …）
 * @param {number} index0
 */
function colIndexToLetters(index0) {
  let n = Math.trunc(index0) + 1;
  if (!Number.isFinite(n) || n < 1) return 'A';
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/**
 * @param {unknown} v
 */
function cellFromBomValue(v) {
  if (v == null) return '';
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * 根据当前批次已对齐飞书的行，在版本目录下覆盖生成「{产品}-{版本}-软件包清单」电子表格。
 * 列顺序来自 bom_scanner.versionSheetColumns（可配置）。
 *
 * @param {object} p
 * @param {string} p.accessToken
 * @param {string} p.rootFolderToken
 * @param {string} p.batchDir
 * @param {string} [p.productName]
 * @param {string} [p.sheetTitle]
 * @param {string[]} [p.columns]
 * @param {ReturnType<typeof mergeKeyMap>} p.keyMap
 * @param {Array<{ bom_row?: unknown, status?: unknown }>} p.rows
 * @param {Awaited<ReturnType<typeof loadFeishuPackageManifest>> | null} [p.packageManifest]
 * @param {string} [p.webBaseUrl]
 * @returns {Promise<{ spreadsheetToken: string, url: string, rowCount: number, sheetTitle: string }>}
 */
export async function generateVersionPackageSheet(p) {
  const { accessToken, rootFolderToken, batchDir, keyMap, rows, packageManifest, webBaseUrl } = p;
  const sheetTitle =
    safeTrim(p.sheetTitle) ||
    buildVersionPackageSheetTitle(p.productName || '', batchDir);
  const header = normalizeVersionSheetColumns(p.columns);
  const versionFolder = await ensureFolderPath(accessToken, rootFolderToken, [batchDir]);
  await removeSameNameSheetIfAny(accessToken, versionFolder, sheetTitle);

  /** @type {Array<{ bomRow: Record<string, unknown>, meta: NonNullable<ReturnType<typeof readFeishuPresentMeta>> }>} */
  const present = [];
  for (const r of rows) {
    const meta = readFeishuPresentMeta(r.status);
    if (!meta) continue;
    const bomRow =
      r.bom_row && typeof r.bom_row === 'object' && !Array.isArray(r.bom_row)
        ? /** @type {Record<string, unknown>} */ (r.bom_row)
        : {};
    present.push({ bomRow, meta });
  }

  if (!present.length) {
    throw new Error('当前版本没有 feishu=present 的行，无法生成软件包清单');
  }

  /** @type {unknown[][]} */
  const values = [header];

  for (const { bomRow, meta } of present) {
    const md5Raw = firstNonEmptyByKeysRelaxed(bomRow, keyMap.expectedMd5);
    const md5 = md5Raw && isValidMd5Hex(md5Raw) ? md5Raw.trim().toLowerCase() : '';
    const middleDir = resolveMiddleDirFromRow(bomRow, keyMap);
    const expectedRel = buildFeishuPackageRelPath(
      middleDir ? [batchDir, middleDir] : [batchDir],
      meta.fileName,
    );
    const byName = packageManifest?.byFileName?.get(meta.fileName.normalize('NFKC')) ?? null;
    const manifestHit =
      byName && (!md5 || !byName.md5 || byName.md5 === md5) ? byName : byName || null;

    const sizeBytes =
      manifestHit && Number.isFinite(manifestHit.size_bytes) && manifestHit.size_bytes >= 0
        ? manifestHit.size_bytes
        : meta.sizeBytes;
    const relPath = (manifestHit?.rel_path || expectedRel || '').normalize('NFKC');
    const downloadUrl = resolvePackageManifestDownloadUrl(
      meta.fileToken,
      webBaseUrl,
      manifestHit?.download_url,
    );
    const uploadedAt = typeof manifestHit?.uploaded_at === 'string' ? manifestHit.uploaded_at : '';

    /** @type {Record<string, unknown>} */
    const extras = {
      size: sizeBytes,
      rel_path: relPath,
      download_url: downloadUrl || '',
      uploaded_at: uploadedAt,
    };

    /** @type {unknown[]} */
    const rowCells = header.map((col) => {
      const kind = extraColumnKind(col);
      if (kind) return extras[kind] ?? '';
      return cellFromBomValue(resolveBomCellByHeader(bomRow, keyMap, col));
    });
    values.push(rowCells);
  }

  const { spreadsheetToken, url } = await createSpreadsheet(
    accessToken,
    versionFolder,
    sheetTitle,
  );
  const sheetId = await queryFirstSheetId(accessToken, spreadsheetToken);
  const endRow = values.length;
  const endCol = colIndexToLetters(header.length - 1);
  const range = `${sheetId}!A1:${endCol}${endRow}`;
  await putSheetValues(accessToken, spreadsheetToken, range, values);

  log('feishu-version-sheet generated', {
    batchDir,
    sheetTitle,
    rowCount: present.length,
    cols: header.length,
    spreadsheetToken: spreadsheetToken.slice(0, 12),
  });
  return { spreadsheetToken, url, rowCount: present.length, sheetTitle };
}

/**
 * 从 DB 加载批次 present 行并生成版本清单表。
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} accessToken
 * @param {string} batchId
 * @param {{ packageManifest?: Awaited<ReturnType<typeof loadFeishuPackageManifest>> | null, webBaseUrl?: string }} [opts]
 */
export async function generateVersionPackageSheetForBatch(supabase, accessToken, batchId, opts = {}) {
  const scannerVal = await fetchBomScannerValue(supabase);
  const keyMap = mergeKeyMap(scannerVal);
  const columns = normalizeVersionSheetColumns(scannerVal?.versionSheetColumns);
  const batchProdCfg = await fetchBatchProductDistributionSettings(supabase, batchId);
  const rootFolder = safeTrim(batchProdCfg.feishuDriveRootFolderToken);
  if (!rootFolder) throw new Error('未配置飞书云盘根目录 folder_token');

  const batchNameRaw = batchProdCfg.batchName;
  const batchNameFallback = `batch-${String(batchId).replace(/-/g, '').slice(0, 8)}`;
  const batchDir = safePathSegment(batchNameRaw || batchNameFallback);
  const productName = safeTrim(batchProdCfg.productName) || 'product';
  const sheetTitle = buildVersionPackageSheetTitle(productName, batchDir);

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
    productName,
    sheetTitle,
    columns,
    keyMap,
    rows: rowList ?? [],
    packageManifest,
    webBaseUrl: opts.webBaseUrl,
  });
}
