/**
 * `open-walnut://` links arriving in the console (src/core/plugin-install-link.ts).
 *
 * Two doors, one handler: the Mac app calls `window.__walnutDesktop.openLink`
 * on a page that is already open (desktop/AppLink.swift), and a page it opens
 * for a link (or a browser given `<address>/#open-link=<link>`) carries it in
 * the fragment, read once before the app mounts and on every hash change. The
 * fragment leaves the address bar at once, so a reload never asks again.
 *
 * Only an install link is understood today. It never installs anything: the
 * Plugin Store shows it as a card, and the user still turns on the trust switch
 * and presses Install. It waits here until they act on that card (Install or
 * Cancel), so a store that mounts again (a re-render, a trip to another page)
 * still shows it. Reading it never clears it: the store once took it on mount
 * and lost it when it mounted a second time.
 */
import { buildInstallLink, parseInstallLink, parseOpenLinkFragment, type InstallLinkTarget } from '../../../src/core/plugin-install-link';
import { log } from '@/utils/log';

/** Where the store lives; App navigates here when a link arrives. */
export const PLUGIN_STORE_PATH = '/settings#plugin-store';

let pending: InstallLinkTarget | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const fn of listeners) {
    try { fn(); } catch (err) { log.warn('open-link', 'listener failed', { error: String(err) }); }
  }
}

/** Hand a link to the console. True when it was one this build understands. */
export function openLink(link: string): boolean {
  const target = parseInstallLink(link);
  if (!target) {
    log.warn('open-link', 'link not understood', { link: link.slice(0, 200) });
    return false;
  }
  pending = target;
  log.info('open-link', 'install link received', target.kind === 'git' ? { url: target.url, ref: target.ref } : { spec: target.spec });
  notify();
  return true;
}

/** The link waiting for the person to act on it, if any. */
export function peekPendingInstall(): InstallLinkTarget | null {
  return pending;
}

/** Install or Cancel on the link's card: forget that link, unless a newer one
 *  has replaced it meanwhile. With no target, forget whatever is waiting. */
export function settlePendingInstall(target?: InstallLinkTarget | null): void {
  if (!pending) return;
  if (target && buildInstallLink(target) !== buildInstallLink(pending)) return;
  pending = null;
}

export function subscribeOpenLinks(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Take an `#open-link=` fragment out of the address bar and handle it. */
export function consumeOpenLinkFragment(target: Window = window): boolean {
  const link = parseOpenLinkFragment(target.location.hash);
  if (!link) return false;
  const { pathname, search } = target.location;
  target.history.replaceState(target.history.state, '', pathname + search);
  return openLink(link);
}

/** Called once before the app mounts: the fragment now, and on every later hash change. */
export function installOpenLinks(target: Window = window): void {
  consumeOpenLinkFragment(target);
  target.addEventListener('hashchange', () => { consumeOpenLinkFragment(target); });
}
