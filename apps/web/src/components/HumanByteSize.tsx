import { useCallback, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { formatBytesHuman } from '../lib/bytesFormat';

type Props = {
  bytes: number;
  /** 简短前缀，如「本地」「远端」 */
  variantLabel?: string;
  className?: string;
};

export function HumanByteSize({ bytes, variantLabel, className = '' }: Props) {
  const [copied, setCopied] = useState(false);
  const human = formatBytesHuman(bytes);
  const title = variantLabel ? `${variantLabel}：${bytes} 字节` : `${bytes} 字节`;

  const copy = useCallback(async () => {
    const s = String(bytes);
    try {
      await navigator.clipboard.writeText(s);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      try {
        const ta = document.createElement('textarea');
        ta.value = s;
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
  }, [bytes]);

  return (
    <div className={`inline-flex items-center gap-1 min-w-0 max-w-full ${className}`}>
      <span className="truncate text-left" title={title}>
        {variantLabel ? (
          <>
            <span className="text-slate-500">{variantLabel}</span>{' '}
            <span className="font-medium text-slate-800 tabular-nums">{human}</span>
          </>
        ) : (
          <span className="font-medium text-slate-800 tabular-nums">{human}</span>
        )}
      </span>
      <button
        type="button"
        onClick={() => void copy()}
        title={copied ? '已复制字节数' : `复制字节数：${bytes}`}
        className="inline-flex shrink-0 rounded p-0.5 text-slate-500 hover:bg-slate-200/80 hover:text-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60"
      >
        {copied ? <Check size={14} className="text-emerald-600" aria-hidden /> : <Copy size={14} aria-hidden />}
        <span className="sr-only">复制字节数</span>
      </button>
    </div>
  );
}

type TripleProps = {
  localBytes: number | null;
  extBytes: number | null;
  /** it-Artifactory 等写入 fileSizeBytes 列的大小 */
  remoteBytes: number | null;
};

/**
 * 自上而下与「选取」优先级一致：ext → 本地（索引）→ Artifactory（it / fileSizeBytes 列）。
 */
export function BomRowByteSizeCell({ localBytes, extBytes, remoteBytes }: TripleProps) {
  const segments: Array<{ bytes: number; label: string }> = [];
  if (extBytes != null) segments.push({ bytes: extBytes, label: 'extArtifactory' });
  if (localBytes != null) segments.push({ bytes: localBytes, label: '本地文件' });
  if (remoteBytes != null) segments.push({ bytes: remoteBytes, label: 'Artifactory' });

  if (segments.length === 0) {
    return <span className="text-slate-400">—</span>;
  }

  return (
    <div className="flex flex-col gap-0.5 min-w-0">
      {segments.map((s, i) => (
        <HumanByteSize key={`${i}-${s.label}`} bytes={s.bytes} variantLabel={s.label} className="text-[11px]" />
      ))}
    </div>
  );
}
