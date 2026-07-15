/**
 * Robust copy-to-clipboard with layered fallbacks.
 *
 * navigator.clipboard only exists in secure contexts — plain-HTTP LAN access
 * (http://192.168.x.x:3456), a primary Walnut deployment mode, does NOT have
 * it. Fall back to the hidden-textarea + execCommand trick; if even that
 * fails, tell the caller so it can show inline-selectable text instead.
 */

export type CopyResult = 'clipboard' | 'execCommand' | 'failed';

export async function copyTextRobust(text: string): Promise<CopyResult> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return 'clipboard';
    }
  } catch { /* permission denied / insecure context — try legacy path */ }

  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    // Off-screen but focusable — display:none breaks select() in some browsers.
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    ta.style.top = '0';
    ta.setAttribute('readonly', '');
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    if (ok) return 'execCommand';
  } catch { /* fall through */ }

  return 'failed';
}
