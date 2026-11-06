/**
 * The page half of handing a Walnut window its browser key (hand-browser-key.ts has the rules):
 * runs in the top frame of Walnut's own pages only (they carry `<meta name="walnut-app">`; the
 * background answers only for the exact address this extension is paired with). It sends the key
 * the page keeps (web/src/api/vault.ts, localStorage `walnut.vault.browser`), writes the one the
 * background answers with when the page has none Walnut knows, and tells the page to read its
 * vault status again (web/src/api/vault-live.ts listens), so a locked Passwords page shares the
 * extension's unlock at once.
 */
import { ask, ext } from './ext'
import { SELF } from './content-state'

const STORAGE_KEY = 'walnut.vault.browser'

export function initPageBrowserKey(isWalnutPage: () => boolean, live: () => boolean): void {
  if (SELF !== 'top') return
  let running = false
  const offer = async (): Promise<void> => {
    if (running || !live() || !isWalnutPage()) return
    running = true
    try {
      let had: string | null
      try { had = localStorage.getItem(STORAGE_KEY) } catch { return } // storage off: nowhere to keep it
      const r = await ask<{ key?: string; origin?: string }>({ type: 'browser-key', ...(had ? { key: had } : {}) })
      if (!r.ok || typeof r.key !== 'string' || r.origin !== location.origin) return
      // The page got its own meanwhile (the person typed the master password here): it keeps that one.
      if (localStorage.getItem(STORAGE_KEY) !== had) return
      localStorage.setItem(STORAGE_KEY, r.key)
      postMessage({ source: 'walnut-extension', type: 'vault-browser-key' }, location.origin)
    } catch { /* the extension went away: nothing handed */ } finally { running = false }
  }
  void offer()
  // Back from the back/forward cache, and after an unlock in the extension while this page is open.
  addEventListener('pageshow', (e) => { if (e.persisted) void offer() })
  ext.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== 'browser-key-offer') return
    void offer()
    sendResponse({ ok: true })
  })
}
