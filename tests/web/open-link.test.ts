/**
 * `open-walnut://` links reaching the console (web/src/utils/open-link.ts): the
 * Mac app's bridge call and the `#open-link=` fragment end in the same pending
 * install, the fragment leaves the address bar so a reload never asks again, the
 * link waits until Install or Cancel settles it (a store mounted again still sees
 * it), and nothing that is not an install link gets through.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildInstallLink, openLinkFragment } from '../../src/core/plugin-install-link';
import {
  consumeOpenLinkFragment, installOpenLinks, openLink, peekPendingInstall, settlePendingInstall, subscribeOpenLinks,
} from '@/utils/open-link';
import { installDesktopBridge } from '@/utils/desktop-bridge';

/** The parts of `window` the module touches. */
function fakeWindow(hash: string) {
  const listeners = new Map<string, Array<() => void>>();
  const replaced: string[] = [];
  const win = {
    location: { hash, pathname: '/settings', search: '?x=1' },
    history: {
      state: { key: 'k' },
      replaceState: (_s: unknown, _t: string, url: string) => { replaced.push(url); win.location.hash = ''; },
    },
    addEventListener: (type: string, fn: () => void) => { listeners.set(type, [...(listeners.get(type) ?? []), fn]); },
    fire: (type: string) => { for (const fn of listeners.get(type) ?? []) fn(); },
    document: {} as Document,
  };
  return { win, replaced };
}

const LINK = buildInstallLink({ kind: 'git', url: 'git@example.com:team/plugins.git', ref: 'main' });

afterEach(() => { settlePendingInstall(); });

describe('open-walnut links in the console', () => {
  it('a fragment on load becomes the pending install and leaves the address bar', () => {
    const { win, replaced } = fakeWindow(openLinkFragment(LINK));
    expect(consumeOpenLinkFragment(win as unknown as Window)).toBe(true);
    expect(replaced).toEqual(['/settings?x=1']);
    expect(peekPendingInstall()).toEqual({ kind: 'git', url: 'git@example.com:team/plugins.git', ref: 'main' });
    // Reading never clears it: a store that mounts a second time still finds it.
    expect(peekPendingInstall()).not.toBeNull();
    // Settling another link leaves it; settling this one (Install or Cancel) clears it.
    settlePendingInstall({ kind: 'npm', spec: 'other' });
    expect(peekPendingInstall()).not.toBeNull();
    settlePendingInstall({ kind: 'git', url: 'git@example.com:team/plugins.git', ref: 'main' });
    expect(peekPendingInstall()).toBeNull();
  });

  it('a later hash change (the app on an old bundle path) is read too, and listeners hear it', () => {
    const { win } = fakeWindow('');
    installOpenLinks(win as unknown as Window);
    expect(peekPendingInstall()).toBeNull();
    const heard = vi.fn();
    const off = subscribeOpenLinks(heard);
    win.location.hash = openLinkFragment(buildInstallLink({ kind: 'npm', spec: '@scope/p@1.0.0' }));
    win.fire('hashchange');
    expect(heard).toHaveBeenCalledTimes(1);
    expect(peekPendingInstall()).toEqual({ kind: 'npm', spec: '@scope/p@1.0.0' });
    off();
  });

  it('any other hash is left alone', () => {
    const { win, replaced } = fakeWindow('#plugin-store');
    expect(consumeOpenLinkFragment(win as unknown as Window)).toBe(false);
    expect(replaced).toEqual([]);
    expect(win.location.hash).toBe('#plugin-store');
  });

  it('the desktop bridge hands a link over in place, and refuses what it does not understand', () => {
    const { win } = fakeWindow('');
    const bridge = installDesktopBridge(win as unknown as Window);
    expect(bridge.openLink(LINK)).toBe(true);
    expect(peekPendingInstall()?.kind).toBe('git');
    settlePendingInstall();
    expect(bridge.openLink('open-walnut://pair?code=1')).toBe(false);
    expect(openLink('https://example.com/plugins.git')).toBe(false);
    expect(peekPendingInstall()).toBeNull();
  });
});
