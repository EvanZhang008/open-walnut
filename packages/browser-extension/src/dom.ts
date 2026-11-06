/** Small DOM helpers for the extension's pages: build nodes without innerHTML for any text. */

type Child = Node | string | null | undefined | false
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, unknown> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue
    if (k === 'class') el.className = String(v)
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener)
    else el.setAttribute(k, v === true ? '' : String(v))
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c)
  return el
}

const COLORS = ['#8a5a2b', '#2f6f9f', '#3d7d4a', '#9a3f6b', '#5b4fa8', '#a8642a', '#2f7f7a', '#7a5230']
/** A site's letter tile, its colour picked from the name so it is the same everywhere. */
export function avatar(name: string): HTMLElement {
  let n = 0
  for (const ch of name) n = (n * 31 + ch.charCodeAt(0)) >>> 0
  const letter = (name.replace(/^www\./, '').match(/[a-z0-9]/i)?.[0] ?? '?').toUpperCase()
  const el = h('span', { class: 'avatar' }, letter)
  el.style.background = COLORS[n % COLORS.length]
  return el
}

export const ICONS = {
  key: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="15" r="4"/><path d="M10.85 12.15 19 4"/><path d="m18 5 2 2"/><path d="m15 8 2 2"/></svg>',
  keyBig: '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="15" r="4"/><path d="M10.85 12.15 19 4"/><path d="m18 5 2 2"/><path d="m15 8 2 2"/></svg>',
  lock: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
  lockBig: '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
  user: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>',
  eye: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
  copy: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
  clock: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  fill: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></svg>',
  search: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
  dice: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="4"/><circle cx="8.5" cy="8.5" r="1"/><circle cx="15.5" cy="15.5" r="1"/><circle cx="15.5" cy="8.5" r="1"/><circle cx="8.5" cy="15.5" r="1"/></svg>',
  out: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6"/><path d="M20 4 10 14"/><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/></svg>',
  card: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/><path d="M6 15h4"/></svg>',
  person: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/><path d="M17 3.5l2 2"/></svg>',
  globe: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18"/></svg>',
  x: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>',
  warn: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 2 20h20L12 3z"/><path d="M12 10v4"/><path d="M12 17h.01"/></svg>',
  /** Walnut's Ask: a speech bubble, for the screens that introduce the extension. */
  askBig: '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/><path d="M9 11h.01"/><path d="M12 11h.01"/><path d="M15 11h.01"/></svg>',
  plug: '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 2v6"/><path d="M15 2v6"/><path d="M6 8h12v4a6 6 0 0 1-12 0z"/><path d="M12 18v4"/></svg>',
}

/** One of this file's own SVGs as nodes (parsed, never innerHTML). */
export function svg(markup: string): Element {
  // Parsed as XML, an <svg> with no namespace is no SVG at all and draws nothing.
  const xml = markup.includes('xmlns=') ? markup : markup.replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" ')
  return document.importNode(new DOMParser().parseFromString(xml, 'image/svg+xml').documentElement, true)
}

export function icon(name: keyof typeof ICONS): HTMLElement {
  return h('span', { 'aria-hidden': 'true', style: 'display:inline-grid' }, svg(ICONS[name]))
}

/** "123456" as "123 456", the way a code is read out. */
export function spacedCode(code: string): string {
  return code.length >= 6 ? `${code.slice(0, Math.ceil(code.length / 2))} ${code.slice(Math.ceil(code.length / 2))}` : code
}

/**
 * A one-time code with the ring that counts down its seconds; `onExpire` when it runs out.
 * It stops counting once it is off the page.
 */
export function totpView(t: { code: string; period: number; remaining: number }, onExpire?: () => void): HTMLElement {
  const R = 7
  const C = 2 * Math.PI * R
  const ring = svg(`<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><circle cx="9" cy="9" r="${R}" fill="none" stroke="currentColor" stroke-opacity=".18" stroke-width="2.2"/><circle class="totp-arc" cx="9" cy="9" r="${R}" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" transform="rotate(-90 9 9)" stroke-dasharray="${C.toFixed(2)}"/></svg>`)
  const secs = h('span', { class: 'totp-secs' }, '')
  const el = h('span', { class: 'totp', 'data-testid': 'totp-code', title: 'One-time code' }, h('span', { class: 'totp-code mono' }, spacedCode(t.code)), h('span', { class: 'totp-ring' }, ring, secs))
  let left = Math.max(0, Math.round(t.remaining))
  const period = Math.max(1, t.period || 30)
  const draw = () => {
    ;(ring.querySelector('.totp-arc') as SVGCircleElement | null)?.setAttribute('stroke-dashoffset', String((C * (1 - left / period)).toFixed(2)))
    secs.textContent = String(left)
    el.classList.toggle('soon', left <= 5)
    el.setAttribute('aria-label', `One-time code ${t.code}, ${left} seconds left`)
  }
  draw()
  const timer = setInterval(() => {
    if (!el.isConnected && left < t.remaining) { clearInterval(timer); return }
    left = Math.max(0, left - 1)
    draw()
    if (left === 0) { clearInterval(timer); onExpire?.() }
  }, 1000)
  return el
}
