/**
 * Robust copy-to-clipboard with layered fallbacks.
 *
 * navigator.clipboard only exists in secure contexts — plain-HTTP LAN access
 * (http://192.168.x.x:3456), a primary Walnut deployment mode, does NOT have
 * it. Fall back to the hidden-textarea + execCommand trick; if even that
 * fails, tell the caller so it can show inline-selectable text instead.
 */

export type CopyResult = 'clipboard' | 'execCommand' | 'failed';

/** Native clipboard bridge injected by the Walnut macOS desktop app (WKWebView).
 *  WKWebView rejects navigator.clipboard writes whose user-gesture has expired
 *  (any async work between click and copy), so the app exposes a message
 *  handler that writes NSPasteboard directly. */
function desktopBridgeCopy(text: string): boolean {
  const handler = (window as unknown as {
    webkit?: { messageHandlers?: { walnutClipboard?: { postMessage: (t: string) => void } } };
  }).webkit?.messageHandlers?.walnutClipboard;
  if (!handler) return false;
  try { handler.postMessage(text); return true; } catch { return false; }
}

/**
 * Copy where the text is computed asynchronously AFTER the user's click
 * (capture flows, network round-trips). Call this SYNCHRONOUSLY inside the
 * click handler with the promise of the eventual text.
 *
 * Safari/WKWebView invalidate the gesture by the time the promise resolves, so
 * a plain writeText there is silently rejected. ClipboardItem accepts a
 * promise minted inside the gesture and Safari honors it when it settles.
 */
export function copyTextDeferred(textPromise: Promise<string>): Promise<CopyResult> {
  try {
    if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
      const item = new ClipboardItem({
        'text/plain': textPromise.then((t) => new Blob([t], { type: 'text/plain' })),
      });
      return navigator.clipboard.write([item]).then(
        () => 'clipboard' as const,
        // Rejected (e.g. Chromium quirk, or the bridge is a better fit) —
        // fall back to the robust path; the gesture may still be live there.
        () => textPromise.then(copyTextRobust),
      );
    }
  } catch { /* ClipboardItem missing — fall through */ }
  return textPromise.then(copyTextRobust);
}

export async function copyTextRobust(text: string): Promise<CopyResult> {
  if (desktopBridgeCopy(text)) return 'clipboard';

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
