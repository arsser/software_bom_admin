import { parsePastedBom, parsePastedFromClipboard, type BomRowRecord } from './bomParser';
import type { BomJsonKeyMap } from './bomScannerSettings';
import {
  extractComponentIdFromRow,
  extractModuleFromRow,
  headerMatchesAny,
  normalizeBomKeyForMatch,
} from './bomRowFields';

/** BOM 表头第一列的模块列名（与 jsonKeyMap.module 语义一致） */
export const MODULE_COLUMN = '模块';

export const ASSEMBLY_HEADERS = ['模块', '组件ID', '备注'] as const;

export type AssemblyParseResult = {
  mapping: Map<string, string>;
  warnings: string[];
};

export type ApplyAssemblyResult = {
  headers: string[];
  rows: BomRowRecord[];
  warnings: string[];
  applied: boolean;
};

function headerEquals(a: string, b: string): boolean {
  return normalizeBomKeyForMatch(a) === normalizeBomKeyForMatch(b);
}

function moduleAliasList(keyMap: BomJsonKeyMap): string[] {
  return keyMap.module?.length ? keyMap.module : ['分组', 'group', 'groupName', '组别', '模块'];
}

export function isModuleAliasHeader(header: string, keyMap: BomJsonKeyMap): boolean {
  const h = header.trim();
  if (!h) return false;
  if (headerEquals(h, MODULE_COLUMN)) return true;
  if (headerMatchesAny(h, moduleAliasList(keyMap))) return true;
  if (/分组/.test(h)) return true;
  return false;
}

/** 去掉 module 别名列，将「模块」置于表头第一列 */
export function normalizeHeadersWithModuleFirst(headers: string[], keyMap: BomJsonKeyMap): string[] {
  const rest = headers.filter((h) => !isModuleAliasHeader(h, keyMap));
  return [MODULE_COLUMN, ...rest];
}

function stripModuleAliasKeys(row: BomRowRecord, keyMap: BomJsonKeyMap): BomRowRecord {
  const next: BomRowRecord = { ...row };
  for (const k of Object.keys(next)) {
    if (k !== MODULE_COLUMN && isModuleAliasHeader(k, keyMap)) {
      delete next[k];
    }
  }
  return next;
}

function resolveAssemblyModuleColumn(headers: string[]): string | null {
  const hit = headers.find((h) => headerEquals(h, '模块'));
  if (hit) return hit;
  return headers.find((h) => headerMatchesAny(h, ['模块', '分组', 'group', 'groupName', '组别'])) ?? null;
}

function resolveAssemblyComponentIdColumn(headers: string[]): string | null {
  const hit = headers.find((h) => headerEquals(h, '组件ID'));
  if (hit) return hit;
  return (
    headers.find((h) => {
      const n = normalizeBomKeyForMatch(h);
      return n === '组件id' || n === 'componentid' || n === 'component_id';
    }) ?? null
  );
}

function buildMappingFromAssemblyRows(
  headers: string[],
  rows: BomRowRecord[],
): { mapping: Map<string, string>; warnings: string[] } {
  const warnings: string[] = [];
  const moduleCol = resolveAssemblyModuleColumn(headers);
  const componentIdCol = resolveAssemblyComponentIdColumn(headers);

  if (!moduleCol) {
    throw new Error('组装表缺少「模块」列');
  }
  if (!componentIdCol) {
    throw new Error('组装表缺少「组件ID」列');
  }

  const mapping = new Map<string, string>();
  rows.forEach((row, idx) => {
    const componentId = (row[componentIdCol] ?? '').trim();
    const moduleName = (row[moduleCol] ?? '').trim();
    if (!componentId) return;
    if (!moduleName) {
      warnings.push(`组装表第 ${idx + 2} 行：组件ID「${componentId}」对应模块为空，已跳过`);
      return;
    }
    const prev = mapping.get(componentId);
    if (prev !== undefined && prev !== moduleName) {
      warnings.push(`组装表：组件ID「${componentId}」重复，已采用最后一行模块「${moduleName}」`);
    }
    mapping.set(componentId, moduleName);
  });

  return { mapping, warnings };
}

/** 解析系统组装粘贴文本，构建 组件ID → 模块 映射（备注列只读，不参与写入） */
export function parseAssemblyMapping(text: string): AssemblyParseResult {
  if (!text.trim()) {
    return { mapping: new Map(), warnings: [] };
  }
  const parsed = parsePastedBom(text);
  const { mapping, warnings } = buildMappingFromAssemblyRows(parsed.headers, parsed.rows);
  return { mapping, warnings };
}

export function parseAssemblyFromClipboard(html: string, text: string): AssemblyParseResult {
  if (!html.trim() && !text.trim()) {
    return { mapping: new Map(), warnings: [] };
  }
  const parsed = parsePastedFromClipboard(html, text);
  const { mapping, warnings } = buildMappingFromAssemblyRows(parsed.headers, parsed.rows);
  return { mapping, warnings };
}

function bomHasComponentIdColumn(headers: string[], rows: BomRowRecord[]): boolean {
  const componentIdKeys = ['组件ID', 'componentId', 'component_id'];
  if (headers.some((h) => componentIdKeys.some((k) => headerEquals(h, k)))) return true;
  if (headers.some((h) => normalizeBomKeyForMatch(h) === '组件id')) return true;
  return rows.some((r) => Boolean(extractComponentIdFromRow(r)));
}

/**
 * 将组装映射应用到 BOM：模块列置首、命中组件ID 的行覆盖模块值。
 * mapping 为空时不修改 BOM。
 */
export function applyAssemblyMappingToBom(
  headers: string[],
  rows: BomRowRecord[],
  mapping: Map<string, string>,
  keyMap: BomJsonKeyMap,
): ApplyAssemblyResult {
  if (mapping.size === 0) {
    return { headers, rows, warnings: [], applied: false };
  }

  if (rows.length > 0 && !bomHasComponentIdColumn(headers, rows)) {
    return {
      headers,
      rows,
      warnings: ['BOM 缺少组件ID 列，无法应用组装映射'],
      applied: false,
    };
  }

  const warnings: string[] = [];
  const normalizedHeaders = normalizeHeadersWithModuleFirst(headers, keyMap);

  const newRows = rows.map((row, idx) => {
    let next = { ...row };
    const componentId = extractComponentIdFromRow(next)?.trim() ?? '';

    if (componentId && mapping.has(componentId)) {
      next[MODULE_COLUMN] = mapping.get(componentId)!;
    } else {
      const existing = extractModuleFromRow(next, keyMap);
      if (existing) {
        next[MODULE_COLUMN] = existing;
      } else if (!(MODULE_COLUMN in next)) {
        next[MODULE_COLUMN] = '';
      }
      if (componentId) {
        warnings.push(`第 ${idx + 1} 行：组件ID「${componentId}」未在组装表中找到`);
      }
    }

    next = stripModuleAliasKeys(next, keyMap);
    return next;
  });

  return {
    headers: normalizedHeaders,
    rows: newRows,
    warnings,
    applied: true,
  };
}
