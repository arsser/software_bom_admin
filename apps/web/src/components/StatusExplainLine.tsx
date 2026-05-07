import { useMemo, useState } from 'react';

/** 过长或多行时折叠展示，可展开全文 */
export function StatusExplainLine({
  label,
  text,
  amberManualHint,
}: {
  label: string;
  text: string | null | undefined;
  /** 本地行：await_manual_download 且文案来自兜底说明（非 local_fetch_error） */
  amberManualHint?: boolean;
}) {
  const raw = text?.trim() ?? '';
  const isDash = !raw;
  const [expanded, setExpanded] = useState(false);

  const needsExpand = useMemo(() => {
    if (isDash) return false;
    if (raw.length > 120) return true;
    const lines = raw.split('\n');
    return lines.length > 3 || (lines.length > 1 && raw.length > 80);
  }, [isDash, raw]);

  const displayBody = isDash ? '—' : raw;

  return (
    <div className="text-left text-[11px] leading-snug">
      <span className="font-medium text-slate-600">{label}：</span>
      <span className={amberManualHint ? 'text-amber-900/90' : 'text-slate-800'}>
        <span
          className={`whitespace-pre-line break-words inline ${
            needsExpand && !expanded ? 'line-clamp-3' : ''
          }`}
        >
          {displayBody}
        </span>
        {needsExpand ? (
          <button
            type="button"
            className="ml-1 text-indigo-600 hover:text-indigo-800 font-medium align-baseline"
            onClick={() => setExpanded((e) => !e)}
          >
            {expanded ? '收起' : '展开'}
          </button>
        ) : null}
      </span>
    </div>
  );
}
