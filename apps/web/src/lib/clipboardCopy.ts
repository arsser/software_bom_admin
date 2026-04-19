/**
 * 在用户手势（如点击）内写入剪贴板。
 * 优先 Async Clipboard；在非安全上下文（如 http 局域网）或 API 失败时回退到 execCommand。
 */
export async function copyTextToClipboard(text: string): Promise<void> {
  if (typeof document === 'undefined') {
    throw new Error('当前环境无法访问剪贴板');
  }

  const nav = globalThis.navigator;
  if (nav?.clipboard?.writeText && globalThis.isSecureContext) {
    try {
      await nav.clipboard.writeText(text);
      return;
    } catch {
      /* 权限被拒等：走回退 */
    }
  }

  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.left = '0';
  ta.style.top = '0';
  ta.style.width = '1px';
  ta.style.height = '1px';
  ta.style.padding = '0';
  ta.style.border = 'none';
  ta.style.outline = 'none';
  ta.style.boxShadow = 'none';
  ta.style.background = 'transparent';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  ta.setSelectionRange(0, text.length);
  try {
    const ok = document.execCommand('copy');
    if (!ok) throw new Error('execCommand(copy) 返回 false');
  } finally {
    document.body.removeChild(ta);
  }
}
