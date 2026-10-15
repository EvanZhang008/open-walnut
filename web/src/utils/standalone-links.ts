/**
 * Home Screen app links to Walnut's own files (spec 5.3, P2). In standalone
 * mode a `target="_blank"` link, or `window.open`, leaves the app for a
 * Safari sheet that has no device token and no way back. A click on a
 * same-origin `/api/...` link is taken over instead: the file is fetched with
 * the device token (auth-fetch) and handed to the browser as a blob download,
 * which iOS shows in its own preview sheet on top of the app.
 */
import { log } from '@/utils/log';

/** Pure: should this link click stay in the app? (absolute href, page origin) */
export function isInAppFileLink(href: string, pageOrigin: string): boolean {
  let url: URL;
  try { url = new URL(href, pageOrigin); } catch { return false; }
  return url.origin === pageOrigin && url.pathname.startsWith('/api/');
}

function fileNameOf(url: URL, anchor: HTMLAnchorElement): string {
  const fromAttr = anchor.getAttribute('download');
  if (fromAttr) return fromAttr;
  const last = url.pathname.split('/').filter(Boolean).pop() ?? 'file';
  try { return decodeURIComponent(last); } catch { return last; }
}

async function downloadAsBlob(url: URL, anchor: HTMLAnchorElement): Promise<void> {
  try {
    const res = await fetch(url.href, { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = fileNameOf(url, anchor);
    a.rel = 'noopener';
    a.dataset.walnutStandaloneDownload = '1';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
  } catch (err) {
    log.warn('standalone-links', 'file link download failed', { path: url.pathname, error: String(err) });
  }
}

/**
 * Install the document listener; returns its remover. The caller decides when
 * (standalone display on the phone layout).
 */
export function installStandaloneLinks(): () => void {
  const onClick = (ev: MouseEvent) => {
    if (ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
    const anchor = (ev.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
    if (!anchor || anchor.dataset.walnutStandaloneDownload) return;
    if (!isInAppFileLink(anchor.href, window.location.origin)) return;
    // Captured before React's root listener, so no handler opens a window.
    ev.preventDefault();
    ev.stopPropagation();
    void downloadAsBlob(new URL(anchor.href), anchor);
  };
  document.addEventListener('click', onClick, true);
  return () => document.removeEventListener('click', onClick, true);
}
