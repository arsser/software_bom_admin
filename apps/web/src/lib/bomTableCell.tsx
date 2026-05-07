import { Fragment, useCallback, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import type { BomJsonKeyMap } from './bomScannerSettings';

/**
 * 与 BOM 明细页「Artifactory-ext 下载链接」一致：整格 `line-clamp-3` + `break-all` 控制换行与最多行数；
 * 主色用 indigo（该列为 emerald）。
 */
const DOWNLOAD_CELL_BASE =
  'line-clamp-3 min-w-0 max-w-full text-left text-[11px] leading-snug break-all font-mono text-indigo-900/90';
const DOWNLOAD_CELL_LINK_DECO = 'underline decoration-indigo-300/80 hover:text-indigo-950';

function normalizeHeaderLabel(h: string): string {
  return h.trim().toLowerCase();
}

export function headerIsDownloadColumn(header: string, keyMap: BomJsonKeyMap): boolean {
  const n = normalizeHeaderLabel(header);
  return keyMap.downloadUrl.some((k) => normalizeHeaderLabel(k) === n);
}

export function headerIsMd5Column(header: string, keyMap: BomJsonKeyMap): boolean {
  const n = normalizeHeaderLabel(header);
  return keyMap.expectedMd5.some((k) => normalizeHeaderLabel(k) === n);
}

/** 从单元格解析 http(s) 链接（支持 Markdown `[text](url)`） */
export function extractHrefFromDownloadCell(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  const looseMd = t.match(/\[([^\]]*)\]\(([^)]+)\)/);
  if (looseMd?.[2]) {
    const u = looseMd[2].trim();
    if (/^https?:\/\//i.test(u)) return u;
  }
  if (/^https?:\/\//i.test(t)) return t;
  return null;
}

/** 链接锚文字：Markdown 用方括号内文案，否则用整格原文（由 CSS 省略号截断） */
function anchorLabelForDownload(raw: string): string {
  const t = raw.trim();
  const strictMd = t.match(/^\[([^\]]*)\]\(([^)]+)\)$/);
  if (strictMd?.[1]?.trim()) return strictMd[1].trim();
  return t;
}

function textToCopyForDownload(raw: string): string {
  const href = extractHrefFromDownloadCell(raw);
  if (href) return href;
  const t = raw.trim();
  const md = t.match(/^\[([^\]]*)\]\(([^)]+)\)$/);
  if (md?.[2]) return md[2].trim();
  return t;
}

function CopyIconButton({ text, title }: { text: string; title: string }) {
  const [copied, setCopied] = useState(false);

  const onClick = useCallback(async () => {
    const v = text.trim();
    if (!v) return;
    try {
      await navigator.clipboard.writeText(v);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      try {
        const ta = document.createElement('textarea');
        ta.value = v;
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1600);
      } catch {
        /* ignore */
      }
    }
  }, [text]);

  return (
    <button
      type="button"
      onClick={() => void onClick()}
      title={copied ? '已复制' : title}
      className="inline-flex shrink-0 rounded p-0.5 text-slate-500 hover:bg-slate-200/80 hover:text-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60"
    >
      {copied ? <Check size={14} className="text-emerald-600" aria-hidden /> : <Copy size={14} aria-hidden />}
      <span className="sr-only">{title}</span>
    </button>
  );
}

export type BomDataTableCellProps = {
  header: string;
  value: string;
  keyMap: BomJsonKeyMap;
  /** 为 true 时单元格内 `\\n` 用 `<br />` 断开，整格与 ext 列相同：`line-clamp-3` + `break-all` */
  multilineDownload?: boolean;
  /** 为 true 时不显示下载路径列旁的复制按钮（链可由浏览器复制） */
  hideDownloadCopy?: boolean;
};

/** 下载路径列：可点击 http(s) 超链接 + 可选复制；MD5 列：等宽 + 复制 */
export function BomDataTableCell({ header, value, keyMap, multilineDownload, hideDownloadCopy }: BomDataTableCellProps) {
  const raw = value ?? '';
  const isDl = headerIsDownloadColumn(header, keyMap);
  const isMd5 = headerIsMd5Column(header, keyMap);

  if (!isDl && !isMd5) {
    return <span className="block max-w-56 truncate">{raw}</span>;
  }

  const href = isDl ? extractHrefFromDownloadCell(raw) : null;
  const copyText = isDl ? textToCopyForDownload(raw) : raw.trim();
  const linkTitle = isDl ? copyText || href || raw : raw;

  if (isDl && multilineDownload) {
    const lines = raw.replace(/\r\n/g, '\n').split('\n');
    const showEmpty = lines.length === 1 && lines[0] === '';
    const showDlCopy = Boolean(copyText) && !hideDownloadCopy;
    const linesBlock = (
      <div className={DOWNLOAD_CELL_BASE}>
        {showEmpty ? (
          <span className="text-slate-400">—</span>
        ) : (
          lines.map((line, idx) => (
            <Fragment key={idx}>
              {idx > 0 ? <br /> : null}
              {line === '' ? null : (() => {
                const lineHref = extractHrefFromDownloadCell(line);
                if (lineHref) {
                  return (
                    <a
                      href={lineHref}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={DOWNLOAD_CELL_LINK_DECO}
                      title={textToCopyForDownload(line) || lineHref || line}
                    >
                      {anchorLabelForDownload(line)}
                    </a>
                  );
                }
                return (
                  <span title={line}>{line}</span>
                );
              })()}
            </Fragment>
          ))
        )}
      </div>
    );
    if (showDlCopy) {
      return (
        <div className="flex items-start gap-1 min-w-0 w-full max-w-full">
          {linesBlock}
          <CopyIconButton text={copyText} title="复制下载路径" />
        </div>
      );
    }
    return <div className="min-w-0 w-full max-w-full">{linesBlock}</div>;
  }

  const showDlCopy = Boolean(copyText) && isDl && !hideDownloadCopy;
  const showMd5Copy = Boolean(copyText) && isMd5;

  return (
    <div className="flex items-center gap-1 min-w-0 w-full max-w-full">
      <div className="min-w-0 flex-1 overflow-hidden">
        {isDl && href ? (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className={`${DOWNLOAD_CELL_BASE} ${DOWNLOAD_CELL_LINK_DECO}`}
            title={linkTitle}
          >
            {anchorLabelForDownload(raw)}
          </a>
        ) : isDl ? (
          <span className={DOWNLOAD_CELL_BASE} title={raw}>
            {raw}
          </span>
        ) : isMd5 ? (
          <span className="block truncate font-mono text-[11px] text-slate-800" title={raw}>
            {raw}
          </span>
        ) : (
          <span className="block truncate" title={raw}>
            {raw}
          </span>
        )}
      </div>
      {showMd5Copy || showDlCopy ? (
        <CopyIconButton text={copyText} title={isMd5 ? '复制 MD5' : '复制下载路径'} />
      ) : null}
    </div>
  );
}
