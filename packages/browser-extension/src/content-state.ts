/**
 * What the page script knows about this frame, shared by its parts (content.ts, content-ui.ts,
 * content-fill.ts): where it runs, whether it is on, the login and card/address forms found,
 * and the field the person is in.
 */
import type { LoginGroup } from './form-detect'
import type { WalletGroup } from './wallet-detect'

export const SELF = (() => {
  try {
    if (window === window.top) return 'top'
    return window.top!.location.origin === location.origin ? 'same-origin-frame' : 'other'
  } catch { return 'other' }
})()
/** This frame may be filled: the top page, or a frame on its origin (a frame of another origin: `cs.mayFill`). */
export const MAY_FILL = SELF !== 'other' && location.origin !== 'null' && /^https?:$/.test(location.protocol)
/** A frame the browser says may be: not sandboxed, on http(s). Whether it is on the top page's site, only the background can say. */
export const MAY_ASK_FILL = location.origin !== 'null' && /^https?:$/.test(location.protocol)

/** The field the person is in: part of a login (`group`) or of a card or address form (`wallet`). */
export interface Active { group?: LoginGroup; wallet?: WalletGroup; role: string; field: HTMLInputElement }

export const cs = {
  /** Off until the background answers, and for good on Walnut's own pages. */
  off: true,
  /**
   * Walnut's own page help (Settings, "Fill and save on web pages"): the field icon, the menu
   * opening in a field, the save bar and noting a sent login. Off, a fill the person asks for
   * (the popup, the context menu, the shortcut) still works, and so do agents.
   */
  pageFill: true,
  /**
   * Walnut's menu and fills work in this frame: the top page and its own origin's frames, and a
   * frame of another origin on the same site (a sign-in embedded from the site's own login host,
   * idmsa.apple.com in an Apple page), which the background tells page-init (`frameFill`). Another
   * site's frame never: a page embedding someone's login is how a page would phish one.
   */
  mayFill: MAY_FILL,
  groups: [] as LoginGroup[],
  wallets: [] as WalletGroup[],
  active: null as Active | null,
  /** Set while Walnut fills: the focus moves a fill makes never open the menu again. */
  filling: false,
  /** Password fields the person typed in (only what they typed is offered for saving). */
  typed: new WeakSet<HTMLInputElement>(),
}

/**
 * Walnut's menu or save bar came up in this frame, or went: the agent's frame, pill and cursor in
 * the top document make way while one is shown (content.ts), since anything drawn over them makes
 * them refuse every click (frame-guard.ts). Set by content.ts.
 */
export const overlay = { shown: (): void => undefined }

export function asFill<T>(work: () => T): T {
  cs.filling = true
  try { return work() } finally { setTimeout(() => { cs.filling = false }, 0) }
}
