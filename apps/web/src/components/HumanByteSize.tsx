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

type DualProps = {
  localBytes: number | null;
  remoteBytes: number | null;
};

/** 本地优先；无本地时显示远端（Artifactory 写入 jsonb 的大小） */
export function BomRowByteSizeCell({ localBytes, remoteBytes }: DualProps) {
  if (localBytes != null) {
    return <HumanByteSize bytes={localBytes} variantLabel="本地" />;
  }
  if (remoteBytes != null) {
    return <HumanByteSize bytes={remoteBytes} variantLabel="远端" />;
  }
  return <span className="text-slate-400">—</span>;
}
