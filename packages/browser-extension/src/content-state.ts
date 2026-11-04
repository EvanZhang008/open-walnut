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
export const MAY_FILL = SELF !== 'other' && location.origin !== 'null' && /^https?:$/.test(location.protocol)

/** The field the person is in: part of a login (`group`) or of a card or address form (`wallet`). */
export interface Active { group?: LoginGroup; wallet?: WalletGroup; role: string; field: HTMLInputElement }

export const cs = {
  /** Off until the background answers, and for good on Walnut's own pages. */
  off: true,
  groups: [] as LoginGroup[],
  wallets: [] as WalletGroup[],
  active: null as Active | null,
  /** Set while Walnut fills: the focus moves a fill makes never open the menu again. */
  filling: false,
  /** Password fields the person typed in (only what they typed is offered for saving). */
  typed: new WeakSet<HTMLInputElement>(),
}

export function asFill<T>(work: () => T): T {
  cs.filling = true
  try { return work() } finally { setTimeout(() => { cs.filling = false }, 0) }
}
