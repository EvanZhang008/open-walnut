/**
 * The popup never draws a late answer over a newer view (packages/browser-extension/src/popup-view.ts;
 * the security review of the shared unlock, Medium 3): an item opened just before a Lock all in
 * another window answered after the lock screen came, drew its details over it, and the watch
 * on the vault, trusting what the last render drew, left them there. Here the real popup.ts and
 * popup-item.ts run on a small fake DOM with the background's answers held back in a chosen
 * order; no browser.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest'

class El {
  children: El[] = []
  classList = { add() {}, remove() {} }
  style: Record<string, string> = {}
  dataset: Record<string, string> = {}
  isConnected = true
  textContent = ''
  disabled = false
  value = ''
  constructor(public tag: string, public attrs: Record<string, unknown> = {}) {}
  append(...v: unknown[]) { this.children.push(...v.filter((x): x is El => x instanceof El)) }
  prepend(...v: unknown[]) { this.children.unshift(...v.filter((x): x is El => x instanceof El)) }
  replaceChildren(...v: unknown[]) { this.children = []; this.append(...v) }
  matches(sel: string): boolean {
    const id = /^#(.+)$/.exec(sel)
    if (id) return this.attrs.id === id[1]
    const t = /^\[data-testid="(.+)"\]$/.exec(sel)
    return !!t && this.attrs['data-testid'] === t[1]
  }
  querySelector(sel: string): El | null {
    if (this.matches(sel)) return this
    for (const c of this.children) { const f = c.querySelector(sel); if (f) return f }
    return null
  }
  querySelectorAll(): El[] { return [] }
  addEventListener() {}
  setAttribute(k: string, v: unknown) { this.attrs[k] = v }
  focus() {}
  select() {}
}
const h = (tag: string, attrs: Record<string, unknown> = {}, ...children: unknown[]) => { const e = new El(tag, attrs); e.append(...children); return e }
const root = h('root')
const polls: Array<() => unknown> = []

let unlocked = true
const held = new Map<string, (r: unknown) => void>()
const hold = (type: string) => new Promise((resolve) => held.set(type, resolve))

const ask = vi.fn(async (msg: { type: string }) => {
  switch (msg.type) {
    case 'state': case 'vault-watch': return { ok: true, connected: true, unlocked }
    case 'site-items': return { ok: true, site: '', items: [] }
    case 'wallet-items': return { ok: true, cards: [], identities: [] }
    case 'vault-status': return { ok: true, status: { setUp: true, waitMs: 0, hasSecretKey: true } }
    case 'item-detail': return hold('item-detail')
    default: return { ok: true }
  }
})

const SRC = '../../../packages/browser-extension/src'
vi.mock('../../../packages/browser-extension/src/ext', () => ({ ask, ext: { windows: { getCurrent: async () => ({ id: 1 }) }, storage: { onChanged: { addListener() {} } } } }))
vi.mock('../../../packages/browser-extension/src/dom', () => ({ h, icon: () => h('icon'), avatar: () => h('avatar'), totpView: () => h('totp') }))
vi.mock('../../../packages/browser-extension/src/popup-ui', () => ({ errLine: () => h('error'), hintLine: () => ({ el: h('hint'), show() {} }), iconButton: () => h('button'), popupIcon: () => h('icon'), toast() {}, topBar: () => h('top'), copyPlain() {}, copySecret() {} }))
vi.mock('../../../packages/browser-extension/src/popup-generator', () => ({ generatorView() {} }))
vi.mock('../../../packages/browser-extension/src/popup-settings', () => ({ settingsView() {} }))
vi.mock('../../../packages/browser-extension/src/popup-connect', () => ({ findWalnut: async () => null, rememberServer() {} }))
vi.mock('../../../packages/browser-extension/src/clipboard-page', () => ({ startClipboardPage() {} }))
vi.mock('../../../packages/browser-extension/src/settings', () => ({ pageFillOn: async () => true }))

const drain = async () => { for (let i = 0; i < 200; i++) await Promise.resolve() }
const lockView = () => !!root.querySelector('#pw')
const detail = () => !!root.querySelector('[data-testid="popup-detail"]')
const SECRET_ITEM = { ok: true, item: { id: 'fake-item', type: 'note', title: 'Fake private item', fields: [{ label: 'Notes', value: 'fake private notes' }] } }

let detailView: typeof import('../../../packages/browser-extension/src/popup-item').detailView
const ctx = () => ({ root: root as unknown as HTMLElement, embedded: false, inWindow: false, back: () => undefined })

beforeAll(async () => {
  const g = globalThis as Record<string, unknown>
  const realInterval = g.setInterval
  // The popup's 3 s watch is called by hand here; the test runner keeps its own timers.
  g.setInterval = (f: () => unknown) => { polls.push(f); return 0 }
  g.document = { getElementById: () => root, documentElement: h('html'), visibilityState: 'visible', addEventListener() {} }
  g.window = { addEventListener() {}, close() {} }
  g.location = { search: '' }
  try { await import(`${SRC}/popup`) } finally { g.setInterval = realInterval }
  await drain()
  ;({ detailView } = await import(`${SRC}/popup-item`))
})

describe('a late answer after a Lock', () => {
  it('an item opened before Lock all never draws over the lock screen, and the next look keeps the lock screen', async () => {
    unlocked = true
    await polls[0]() // settled on the unlocked list
    const opening = detailView({ id: 'fake-item', title: 'Fake private item', hasTotp: false, type: 'note' }, false, ctx())
    await drain()
    unlocked = false // Lock all in another window
    await polls[0]()
    await drain()
    expect(lockView()).toBe(true)
    held.get('item-detail')!(SECRET_ITEM)
    await opening
    await drain()
    expect(detail()).toBe(false)
    expect(lockView()).toBe(true)
    await polls[0]()
    await drain()
    expect(detail()).toBe(false)
    expect(lockView()).toBe(true)
  })

  it('an item that answers in time is shown, and a Lock after it replaces it with the lock screen', async () => {
    unlocked = true
    await polls[0]()
    await drain()
    expect(lockView()).toBe(false)
    const opening = detailView({ id: 'fake-item', title: 'Fake private item', hasTotp: false, type: 'note' }, false, ctx())
    await drain()
    held.get('item-detail')!(SECRET_ITEM)
    await opening
    expect(detail()).toBe(true)
    // The watch reads the view on show (the item, drawn outside render), not what render drew last.
    unlocked = false
    await polls[0]()
    await drain()
    expect(detail()).toBe(false)
    expect(lockView()).toBe(true)
  })
})
