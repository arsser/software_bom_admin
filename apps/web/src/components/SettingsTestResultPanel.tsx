import React, { useEffect, useState } from 'react';
import { CheckCircle2, AlertCircle, ChevronRight, ChevronDown } from 'lucide-react';

/** 设置页测试结果：成功绿 / 失败红，简要信息默认展示，完整 JSON 可展开 */
export const SettingsTestResultPanel: React.FC<{
  ok: boolean;
  summary: React.ReactNode;
  detail: unknown;
}> = ({ ok, summary, detail }) => {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    setOpen(false);
  }, [detail]);
  const shell = ok
    ? 'border-emerald-200 bg-emerald-50/70'
    : 'border-red-200 bg-red-50/70';
  const iconWrap = ok ? 'text-emerald-600' : 'text-red-600';
  const summaryTone = ok ? 'text-emerald-950' : 'text-red-950';

  return (
    <div className={`mt-2 rounded-lg border ${shell} overflow-hidden`}>
      <div className="flex items-start gap-2 px-3 py-2.5">
        <span className={`shrink-0 mt-0.5 ${iconWrap}`}>
          {ok ? <CheckCircle2 size={18} aria-hidden /> : <AlertCircle size={18} aria-hidden />}
        </span>
        <div className={`min-w-0 flex-1 text-sm leading-snug ${summaryTone}`}>{summary}</div>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="shrink-0 inline-flex items-center gap-0.5 text-xs font-medium text-slate-600 hover:text-slate-900 py-0.5 px-1 rounded-md hover:bg-white/60 transition-colors"
        >
          {open ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
          {open ? '收起' : '详情'}
        </button>
      </div>
      {open ? (
        <pre className="text-xs font-mono border-t border-slate-200/80 bg-white/85 text-slate-800 p-3 max-h-72 overflow-auto whitespace-pre-wrap break-all">
          {JSON.stringify(detail, null, 2)}
        </pre>
      ) : null}
    </div>
  );
};
