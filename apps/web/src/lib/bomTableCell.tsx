import { useCallback, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import type { BomJsonKeyMap } from './bomScannerSettings';

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
  /** 为 true 时下载路径列按行换行展示（含单元格内换行），每行可单独解析链接 */
  multilineDownload?: boolean;
};

/** 下载路径列：可点击 http(s) 超链接 + 复制；MD5 列：等宽 + 复制 */
export function BomDataTableCell({ header, value, keyMap, multilineDownload }: BomDataTableCellProps) {
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
    return (
      <div className="flex items-start gap-1 min-w-0 w-full max-w-full">
        <div className="min-w-0 flex-1 space-y-0.5 text-left">
          {showEmpty ? (
            <span className="text-slate-400">—</span>
          ) : (
            lines.map((line, idx) => {
              const lineHref = extractHrefFromDownloadCell(line);
              if (lineHref) {
                return (
                  <a
                    key={idx}
                    href={lineHref}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block break-all text-indigo-600 hover:text-indigo-800 hover:underline text-[11px] leading-snug"
                    title={textToCopyForDownload(line) || lineHref || line}
                  >
                    {anchorLabelForDownload(line)}
                  </a>
                );
              }
              if (line === '') {
                return <div key={idx} className="min-h-[0.5rem]" aria-hidden />;
              }
              return (
                <span
                  key={idx}
                  className="block break-all text-slate-800 text-[11px] leading-snug whitespace-pre-wrap"
                  title={line}
                >
                  {line}
                </span>
              );
            })
          )}
        </div>
        {copyText ? (
          <CopyIconButton text={copyText} title="复制下载路径" />
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1 min-w-0 w-full max-w-full">
      <div className="min-w-0 flex-1 overflow-hidden">
        {isDl && href ? (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="block truncate text-indigo-600 hover:text-indigo-800 hover:underline text-left"
            title={linkTitle}
          >
            {anchorLabelForDownload(raw)}
          </a>
        ) : isDl ? (
          <span className="block truncate text-slate-800" title={raw}>
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
      {copyText ? (
        <CopyIconButton text={copyText} title={isMd5 ? '复制 MD5' : '复制下载路径'} />
      ) : null}
    </div>
  );
}
