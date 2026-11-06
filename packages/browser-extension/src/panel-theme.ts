/**
 * The theme of the extension's own pages beside Walnut's frame (the side panel, the toolbar popup,
 * the key popover, the Passwords and Settings views): Walnut's General theme, which the Ask frame
 * says (`{ type: 'theme', theme }`, panel-ask.ts), so a person who picked Dark in Walnut gets a dark
 * popover over a dark Ask even on a light system (review R1-19). `system` follows the browser.
 *
 * Kept in this extension's localStorage, which every one of its pages reads synchronously before it
 * draws (no light flash before a dark view) and hears change at once (the `storage` event), so an
 * open Passwords view follows a change made in Walnut while it shows.
 */
export type Theme = 'dark' | 'light' | 'system'

const KEY = 'walnutTheme'

const valid = (t: unknown): t is Theme => t === 'dark' || t === 'light' || t === 'system'

function apply(t: Theme): void {
  const list = document.documentElement?.classList
  if (typeof list?.toggle !== 'function') return
  list.toggle('theme-dark', t === 'dark')
  list.toggle('theme-light', t === 'light')
}

function kept(): Theme {
  try {
    const t = localStorage.getItem(KEY)
    return valid(t) ? t : 'system'
  } catch { return 'system' }
}

/** Draw in the kept theme now, and follow it while this page is open. */
export function followTheme(): void {
  apply(kept())
  globalThis.addEventListener?.('storage', (e) => { if ((e as StorageEvent).key === KEY) apply(kept()) })
}

/** What the Ask frame says Walnut's theme is: this page takes it, and every other page of the extension too. */
export function keepTheme(t: unknown): void {
  if (!valid(t)) return
  apply(t)
  try { if (localStorage.getItem(KEY) !== t) localStorage.setItem(KEY, t) } catch { /* storage off: this page only */ }
}
