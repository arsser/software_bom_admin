import type { BomJsonKeyMap } from './bomScannerSettings';

export type BomRowRecord = Record<string, string>;

export type BomWarning = {
  rowIndex: number;
  message: string;
};

export type HeaderValidationResult = {
  ok: boolean;
  missingGroups: Array<'downloadUrl' | 'expectedMd5'>;
};

function normalizeMarkdownLink(text: string): string {
  return text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$2');
}

function rowsToRecords(tableRows: string[][]): { headers: string[]; rows: BomRowRecord[] } {
  if (tableRows.length < 2) {
    throw new Error('至少需要 1 行表头 + 1 行数据');
  }
  const headers = tableRows[0].map((h, idx) => {
    const key = h.trim();
    return key.length > 0 ? key : `col_${idx + 1}`;
  });
  if (!headers.length || headers.every((h) => !h)) {
    throw new Error('未识别到有效表头');
  }

  const rows = tableRows.slice(1).map((rawCols) => {
    let cols = [...rawCols];
    // Excel/HTML 纵向合并：后续行往往少最左侧若干格（rowspan 不重复输出 td），数据整体左移。
    // 将列数对齐到表头宽度：左侧补空，再与“首列空则前向填充”配合。
    if (cols.length < headers.length) {
      const missing = headers.length - cols.length;
      cols = [...Array(missing).fill(''), ...cols];
    } else if (cols.length > headers.length) {
      cols = cols.slice(0, headers.length);
    }

    const row: BomRowRecord = {};
    for (let c = 0; c < headers.length; c += 1) {
      const key = headers[c];
      row[key] = (cols[c] ?? '').trim();
    }
    return row;
  });

  // 兼容 Excel 合并单元格：第一列通常只有首行有值，后续行为空。
  // 对第一列做前向填充，保证分组字段在每一行都可用。
  if (headers.length > 0) {
    const firstKey = headers[0];
    let lastValue = '';
    for (const row of rows) {
      const current = (row[firstKey] ?? '').trim();
      if (current) {
        lastValue = current;
      } else if (lastValue) {
        row[firstKey] = lastValue;
      }
    }
  }

  return { headers, rows };
}

function pickDelimiter(headerLine: string): string {
  if (headerLine.includes('\t')) return '\t';
  if (headerLine.includes(',')) return ',';
  return '|';
}

function parseDelimitedTable(input: string, delimiter: string): string[][] {
  const text = input.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;

  const pushCell = () => {
    row.push(cell.trim());
    cell = '';
  };

  const pushRow = () => {
    // 忽略完全空白的行，避免用户末尾多回车产生空记录
    if (row.some((c) => c.length > 0)) {
      rows.push(row);
    }
    row = [];
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (ch === '"') {
      if (inQuotes && i + 1 < text.length && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (!inQuotes && ch === delimiter) {
      pushCell();
      continue;
    }

    if (!inQuotes && ch === '\n') {
      pushCell();
      pushRow();
      continue;
    }

    cell += ch;
  }

  pushCell();
  pushRow();

  return rows;
}

export function parsePastedBom(input: string): { headers: string[]; rows: BomRowRecord[] } {
  const normalized = normalizeMarkdownLink(input);
  if (!normalized.trim()) {
    throw new Error('请输入 BOM 内容');
  }

  const firstLine = normalized.split('\n').find((l) => l.trim().length > 0) ?? '';
  const delimiter = pickDelimiter(firstLine);

  let tableRows = parseDelimitedTable(normalized, delimiter);

  // 兼容 Markdown 表头分隔线：| --- | --- |
  if (delimiter === '|' && tableRows.length >= 2) {
    const isMdSep = tableRows[1].every((c) => /^:?-{3,}:?$/.test(c.replace(/\s+/g, '')));
    if (isMdSep) {
      tableRows = [tableRows[0], ...tableRows.slice(2)];
    }
  }

  return rowsToRecords(tableRows);
}

function parseHtmlTable(html: string): string[][] | null {
  try {
    if (typeof DOMParser === 'undefined') return null;
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const table = doc.querySelector('table');
    if (!table) return null;
    const rows: string[][] = [];
    table.querySelectorAll('tr').forEach((tr) => {
      const cells = Array.from(tr.querySelectorAll('th,td')).map((c) => (c.textContent ?? '').trim());
      if (cells.length > 0) rows.push(cells);
    });
    return rows.length > 0 ? rows : null;
  } catch {
    return null;
  }
}

export function parsePastedFromClipboard(html: string, text: string): { headers: string[]; rows: BomRowRecord[] } {
  const htmlRows = parseHtmlTable(html);
  if (htmlRows && htmlRows.length > 1) {
    return rowsToRecords(htmlRows);
  }
  return parsePastedBom(text);
}

function normalizeHeader(header: string): string {
  return header.trim().toLowerCase();
}

export function validateRequiredHeaders(headers: string[], keyMap: BomJsonKeyMap): HeaderValidationResult {
  const headerSet = new Set(headers.map(normalizeHeader));
  const hasDownloadUrl = keyMap.downloadUrl.some((k) => headerSet.has(normalizeHeader(k)));
  const hasExpectedMd5 = keyMap.expectedMd5.some((k) => headerSet.has(normalizeHeader(k)));

  const missingGroups: Array<'downloadUrl' | 'expectedMd5'> = [];
  if (!hasDownloadUrl) missingGroups.push('downloadUrl');
  if (!hasExpectedMd5) missingGroups.push('expectedMd5');

  return {
    ok: missingGroups.length === 0,
    missingGroups,
  };
}

function firstByKeys(row: BomRowRecord, keys: string[]): string | null {
  for (const key of keys) {
    if (key in row) {
      const v = (row[key] ?? '').trim();
      if (v) return v;
    }
  }
  return null;
}

function isValidMd5(value: string): boolean {
  return /^[a-fA-F0-9]{32}$/.test(value.trim());
}

export function buildBomWarnings(rows: BomRowRecord[], keyMap: BomJsonKeyMap): BomWarning[] {
  const warnings: BomWarning[] = [];

  rows.forEach((row, idx) => {
    const rowIndex = idx + 1;
    const download = firstByKeys(row, keyMap.downloadUrl);
    const md5 = firstByKeys(row, keyMap.expectedMd5);

    if (!download) {
      warnings.push({ rowIndex, message: '缺少下载路径字段（仅告警，不阻断入库）' });
    }

    if (!md5) {
      warnings.push({ rowIndex, message: '缺少 MD5 字段（仅告警，不阻断入库）' });
    } else if (!isValidMd5(md5)) {
      warnings.push({ rowIndex, message: `MD5 格式不合法：${md5}` });
    }
  });

  return warnings;
}
