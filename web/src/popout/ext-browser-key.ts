/**
 * The side panel's and the popup's Walnut frame shares the extension's unlock (docs/reference/
 * passwords.md, "One unlock on this computer"). The frame is no tab, so the extension's page script
 * that hands a Walnut tab its browser key never runs in it, and its approval cards read Passwords
 * as locked while the key over them, the extension's, read it unlocked (review round 5, Opus #3:
 * an agent's "Place order" asked for the master password again in an unlocked window).
 *
 * While the extension says it is unlocked and this frame holds no live unlock, the frame asks its
 * page for the key to keep (`browser-key-ask` with the key it has); the page asks the background
 * (packages/browser-extension/src/hand-browser-key.ts handPanelBrowserKey) and answers
 * `browser-key`. The frame keeps a new key only when it still has the one it asked with, then reads
 * its vault status again (api/vault-live.ts), which joins the unlock.
 */
import { useEffect, useRef } from 'react';
import { checkVault, vaultLive } from '@/api/vault-live';
import { log } from '@/utils/log';
import { toParent } from './ext-frame';

const BROWSER_KEY = 'walnut.vault.browser';
const readKey = (): string | null => { try { return localStorage.getItem(BROWSER_KEY); } catch { return null; } };

/** The frame's answer to `browser-key` (the page's reply to its ask). */
export function takeBrowserKey(key: string | undefined, askedWith: string | null): void {
  if (key && readKey() === askedWith) {
    try { localStorage.setItem(BROWSER_KEY, key); } catch { /* storage off: the read below still asks */ }
  }
  void checkVault().then((st) => log.info('ext-panel', 'shared the extension unlock', { unlocked: !!st?.unlocked, newKey: !!key }));
}

/**
 * Ask for the key whenever the extension's word turns to unlocked while this frame holds no live
 * unlock. Returns the key the last ask went with, for `takeBrowserKey`.
 */
export function useExtBrowserKey(extensionUnlocked: boolean): { askedWith: () => string | null } {
  const asked = useRef<string | null>(null);
  useEffect(() => {
    if (!extensionUnlocked || vaultLive()) return;
    asked.current = readKey();
    toParent({ type: 'browser-key-ask', ...(asked.current ? { key: asked.current } : {}) });
  }, [extensionUnlocked]);
  return { askedWith: () => asked.current };
}
