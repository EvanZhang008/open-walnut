/**
 * What Walnut draws into a page (the icon, the menu, the save bar, a toast, the agent frame):
 * each in a host element with a closed shadow root and !important styles, so a page rule cannot
 * restyle it; content.ts watches the hosts and closes what a page changes.
 */
import { ext } from './ext'

export interface Host { el: HTMLElement; expected: string }
export const hosts = new Set<Host>()
/** content.ts watches each host made (its MutationObserver). */
export const hostHooks = { made: (_h: Host): void => undefined }

export function hostStyle(host: Host, extra: string): void {
  host.el.style.cssText = `all: initial !important; position: fixed !important; display: block !important; opacity: 1 !important; visibility: visible !important; filter: none !important; transform: none !important; clip-path: none !important; mix-blend-mode: normal !important; pointer-events: auto !important; ${extra}`
  host.expected = host.el.style.cssText
}

/** The host's own pseudo-elements, which a page rule could draw over the frame: !important in a shadow root wins. */
const SHADOW_STYLE = ':host::before, :host::after { content: none !important; display: none !important; }'

/**
 * Checked right before a fill or a save: is the page faded or hidden around the host, or
 * does something in the top layer (a popover, a modal dialog, full screen) lie over it?
 */
export function tampered(h: Host): boolean {
  for (const el of [document.documentElement, document.body]) {
    if (!el) continue
    const cs = getComputedStyle(el)
    if (Number(cs.opacity) < 1 || cs.visibility !== 'visible' || /opacity|blur|brightness\(0|contrast\(0/.test(cs.filter)) return true
  }
  const r = h.el.getBoundingClientRect()
  for (const sel of [':popover-open', 'dialog:modal', ':fullscreen']) {
    let found: Element[] = []
    try { found = [...document.querySelectorAll(sel)] } catch { continue }
    for (const el of found) {
      const o = el.getBoundingClientRect()
      if (o.right > r.left && o.left < r.right && o.bottom > r.top && o.top < r.bottom) return true
    }
  }
  return false
}

export function makeHost(z: number, mark?: 'walnutMenu' | 'walnutSavebar' | 'walnutCursor'): { host: Host; root: ShadowRoot } {
  const el = document.createElement('walnut-ext')
  el.dataset.walnutHost = '1'
  if (mark) el.dataset[mark] = '1' // set before the watch starts: a later attribute change is the page's
  const host: Host = { el, expected: '' }
  hostStyle(host, `z-index: ${z} !important; top: 0 !important; left: 0 !important;`)
  const root = el.attachShadow({ mode: 'closed' })
  const style = document.createElement('style')
  style.textContent = SHADOW_STYLE
  root.appendChild(style)
  document.documentElement.appendChild(el)
  hosts.add(host)
  hostHooks.made(host)
  return { host, root }
}

export function dropHost(h: Host): void {
  hosts.delete(h)
  h.el.remove()
}

/**
 * An extension page in a frame, given its nonce once it has loaded, by postMessage to the
 * extension's own origin. A second load means the page navigated the frame: `onAgain` closes it.
 */
export function extFrame(page: string, nonce: string, onAgain: () => void, onLoad?: () => void): HTMLIFrameElement {
  const frame = document.createElement('iframe')
  const url = ext.runtime.getURL(page)
  let loads = 0
  frame.addEventListener('load', () => {
    if (++loads > 1) { onAgain(); return }
    frame.contentWindow?.postMessage({ walnutNonce: nonce }, new URL(url).origin)
    onLoad?.()
  })
  frame.src = url
  return frame
}
