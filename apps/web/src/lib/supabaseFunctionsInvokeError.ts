/**
 * `supabase.functions.invoke` 在 Edge 返回非 2xx 时，`error.message` 常为固定文案
 * 「Edge Function returned a non-2xx status code」，真实原因在 `error.context`（fetch Response）的 body 里。
 */
export async function formatFunctionsInvokeError(error: unknown): Promise<string> {
  if (!error || typeof error !== 'object') {
    return error instanceof Error ? error.message : String(error);
  }
  const e = error as Error & { name?: string; context?: unknown; message?: string };
  const fallback = e.message?.trim() || 'Edge Function 调用失败';
  const ctx = e.context;
  if (!(ctx instanceof Response)) {
    return fallback;
  }
  const status = ctx.status;
  try {
    const ct = (ctx.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (ct === 'application/json' || ct === 'application/problem+json') {
      const j: unknown = await ctx.json();
      if (j && typeof j === 'object' && !Array.isArray(j)) {
        const o = j as Record<string, unknown>;
        const detail =
          (typeof o.error === 'string' && o.error.trim()) ||
          (typeof o.message === 'string' && o.message.trim()) ||
          (typeof o.details === 'string' && o.details.trim());
        if (detail) return `HTTP ${status}：${detail}`;
      }
      const s = JSON.stringify(j);
      if (s && s !== '{}' && s !== 'null') return `HTTP ${status}：${s.slice(0, 500)}`;
    } else {
      const t = await ctx.text();
      const trimmed = t?.trim();
      if (trimmed) return `HTTP ${status}：${trimmed.slice(0, 600)}`;
    }
  } catch {
    // body 已读或解析失败时退回
  }
  return `HTTP ${status} ${fallback}`;
}
