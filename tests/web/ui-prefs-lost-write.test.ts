/**
 * A write the browser's storage takes and then drops is still this page's value
 * (web/src/utils/ui-prefs-sync.ts, "What this page wrote").
 *
 * 2026-11-15, the Mac app: WebKit's storage database was locked for two days, every write failed
 * in the background ("SQLiteStorageArea::setItem failed ... database is locked"), and WebKit put
 * the page's storage back to what was on disk. The user closed the Org side bar and a panel, went
 * to Home and back, and both were open again: every reader (view memory, the layout record) read
 * the reverted storage. Here "WebKit puts it back" is a write straight into the storage's own map,
 * past the wrapped methods.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

vi.mock('@/api/client', () => ({
  apiGet: async () => ({ prefs: {} }),
  apiPut: async () => undefined,
}))
vi.mock('@/api/device-token', () => ({ getDeviceToken: () => null }))

/** Keys the storage refuses, as a full one does. */
const refuse = new Set<string>()
/** Reads that throw, as a storage the browser turned off does. */
let refuseReads = false
class MapStorage {
  m = new Map<string, string>()
  getItem(k: string): string | null {
    if (refuseReads) throw new Error('SecurityError')
    return this.m.has(k) ? this.m.get(k)! : null
  }
  setItem(k: string, v: string): void {
    if (refuse.has(k)) throw new Error('QuotaExceededError')
    this.m.set(k, String(v))
  }
  removeItem(k: string): void { this.m.delete(k) }
  clear(): void { this.m.clear() }
}
class FakeStorageEvent extends Event {
  key: string | null
  newValue: string | null
  storageArea: unknown
  constructor(type: string, init: { key?: string | null; newValue?: string | null; storageArea?: unknown } = {}) {
    super(type)
    this.key = init.key ?? null
    this.newValue = init.newValue ?? null
    this.storageArea = init.storageArea ?? null
  }
}

let local: MapStorage
let win: EventTarget
let mod: typeof import('../../web/src/utils/ui-prefs-sync')
let viewMemory: typeof import('../../web/src/utils/view-memory')
let layout: typeof import('../../web/src/utils/layout-record')

const RAIL = 'open-walnut-view:org.node.railHidden'

beforeEach(async () => {
  refuse.clear()
  refuseReads = false
  local = new MapStorage()
  // What the disk held when the storage locked: the side bar open.
  local.m.set(RAIL, JSON.stringify([['project:walnut', false]]))
  win = new EventTarget()
  Object.assign(globalThis, {
    Storage: MapStorage, localStorage: local, sessionStorage: new MapStorage(), window: win,
    document: new EventTarget(), StorageEvent: FakeStorageEvent,
  })
  Object.defineProperty(globalThis, 'navigator', { value: { webdriver: false }, configurable: true })
  vi.resetModules()
  mod = await import('../../web/src/utils/ui-prefs-sync')
  await mod.initUiPrefsSync()
  viewMemory = await import('../../web/src/utils/view-memory')
  layout = await import('../../web/src/utils/layout-record')
})
afterEach(() => {
  mod?.__resetUiPrefsSyncForTests()
  for (const k of ['Storage', 'localStorage', 'sessionStorage', 'window', 'document', 'StorageEvent']) delete (globalThis as Record<string, unknown>)[k]
})

/** WebKit puts the storage back to what was on disk, past every wrapped method. */
const revert = (key: string, disk: string | null) => { if (disk === null) local.m.delete(key); else local.m.set(key, disk) }

describe('a write the storage drops', () => {
  it('a view closed a moment ago stays closed on the next mount after the storage put it back', () => {
    const disk = local.m.get(RAIL)!
    expect(viewMemory.writeView(RAIL, 'project:walnut', true)).toBe(true)
    revert(RAIL, disk)
    // Nothing of the key on screen (the page was left): the next mount reads storage.
    expect(viewMemory.storedView(viewMemory.shownText(RAIL), 'project:walnut', viewMemory.isBoolean)).toBe(true)
    expect(localStorage.getItem(RAIL)).toBe(JSON.stringify([['project:walnut', true]]))
  })

  it('a key kept only on this device (a session panel\'s Reading split) is kept the same way', () => {
    // The session panel's view (panel-view.ts): never mirrored to the server, so storage is its only copy.
    const PANEL = 'open-walnut-view:panel.view'
    expect(mod.syncable(PANEL)).toBe(false)
    local.m.set(PANEL, JSON.stringify([['home-column:s-interview', { view: null }]]))
    const disk = local.m.get(PANEL)!
    viewMemory.writeView(PANEL, 'home-column:s-interview', { view: null, reader: { on: true, share: 0.6 } })
    revert(PANEL, disk)
    // The column shows another session and comes back: the panel mounts again.
    expect(viewMemory.storedView(viewMemory.shownText(PANEL), 'home-column:s-interview', (v): v is { reader?: { on: boolean } } => !!v && typeof v === 'object')?.reader?.on).toBe(true)
  })

  it('every reader gets the page\'s own value: the layout record and a removed key too', () => {
    layout.writeColumns('homeColumns', [{ id: 's-1', locked: true }])
    revert(layout.LAYOUT_FIELDS.homeColumns, null)
    expect(layout.readColumns('homeColumns', { session: null })).toEqual([{ id: 's-1', locked: true }])
    localStorage.setItem('open-walnut-x', 'a')
    localStorage.removeItem('open-walnut-x')
    revert('open-walnut-x', 'a')
    expect(localStorage.getItem('open-walnut-x')).toBeNull()
  })

  it('another tab\'s write hands the key back to storage; this module\'s own events do not', () => {
    localStorage.setItem('open-walnut-y', 'mine')
    // Its own merge events carry no storage area.
    win.dispatchEvent(new FakeStorageEvent('storage', { key: 'open-walnut-y', newValue: 'mine' }))
    revert('open-walnut-y', null)
    expect(localStorage.getItem('open-walnut-y')).toBe('mine')
    // Another tab wrote it: storage holds that tab's value now, even its put-back to the old one.
    win.dispatchEvent(new FakeStorageEvent('storage', { key: 'open-walnut-y', newValue: null, storageArea: local }))
    expect(localStorage.getItem('open-walnut-y')).toBeNull()
    // A clear in another tab hands every key back.
    localStorage.setItem('open-walnut-z', 'mine')
    local.m.clear()
    win.dispatchEvent(new FakeStorageEvent('storage', { key: null, storageArea: local }))
    expect(localStorage.getItem('open-walnut-z')).toBeNull()
  })

  it('a value no write of this page put there is someone else\'s (an extension\'s content script, a tab whose event has not arrived): storage wins', () => {
    // The page forgot its browser key; the extension then writes a new one from its own world.
    localStorage.setItem('walnut.vault.browser', 'old-key')
    localStorage.removeItem('walnut.vault.browser')
    local.m.set('walnut.vault.browser', 'handed-key')
    expect(localStorage.getItem('walnut.vault.browser')).toBe('handed-key')
    // And from then on storage holds the key: a later put-back of it is not this page's to undo.
    local.m.delete('walnut.vault.browser')
    expect(localStorage.getItem('walnut.vault.browser')).toBeNull()
    // A put-back to one of this page's own earlier writes is still a lost write.
    localStorage.setItem('open-walnut-w', '1')
    localStorage.setItem('open-walnut-w', '2')
    localStorage.setItem('open-walnut-w', '3')
    revert('open-walnut-w', '2')
    expect(localStorage.getItem('open-walnut-w')).toBe('3')
    // What the disk held before this page's first write stays known after many writes.
    local.m.set('open-walnut-v', 'disk')
    for (let i = 0; i < 40; i++) localStorage.setItem('open-walnut-v', `w${i}`)
    revert('open-walnut-v', 'disk')
    expect(localStorage.getItem('open-walnut-v')).toBe('w39')
  })

  it('another tab\'s turn on a key does not forget what the disk held: a later write of this page still survives a put-back', () => {
    local.m.set('open-walnut-k', 'disk')
    localStorage.setItem('open-walnut-k', 'A')
    // Another tab writes B (it never reaches the disk either), and its event arrives.
    local.m.set('open-walnut-k', 'B')
    win.dispatchEvent(new FakeStorageEvent('storage', { key: 'open-walnut-k', newValue: 'B', storageArea: local }))
    localStorage.setItem('open-walnut-k', 'C')
    revert('open-walnut-k', 'disk')
    expect(localStorage.getItem('open-walnut-k')).toBe('C')
    // The other tab's value is one a put-back can bring too.
    revert('open-walnut-k', 'B')
    expect(localStorage.getItem('open-walnut-k')).toBe('C')
  })

  it('a read storage refuses still answers this page\'s own value', () => {
    localStorage.setItem('open-walnut-r', 'mine')
    refuseReads = true
    try { expect(localStorage.getItem('open-walnut-r')).toBe('mine') } finally { refuseReads = false }
  })

  it('the write stamps keep another tab\'s stamp that storage holds before its event arrives', () => {
    const META = 'open-walnut-ui-prefs-sync-meta'
    localStorage.setItem('open-walnut-a', '1')
    // Another tab stamped its key; its storage event has not reached this page yet.
    const theirs = JSON.parse(local.m.get(META) ?? '{}') as Record<string, number>
    local.m.set(META, JSON.stringify({ ...theirs, 'open-walnut-b': 42 }))
    localStorage.setItem('open-walnut-c', '1')
    const stamps = JSON.parse(localStorage.getItem(META) ?? '{}') as Record<string, number>
    expect(stamps['open-walnut-b']).toBe(42)
    expect(stamps['open-walnut-a']).toBeGreaterThan(0)
    expect(stamps['open-walnut-c']).toBeGreaterThan(0)
  })

  it('a write the storage refuses (quota) is not kept as this page\'s: the caller is told, as before', () => {
    local.m.set('open-walnut-q', 'old')
    refuse.add('open-walnut-q')
    expect(() => localStorage.setItem('open-walnut-q', 'new')).toThrow()
    expect(localStorage.getItem('open-walnut-q')).toBe('old')
  })
})

describe('every reader of localStorage goes through the wrapped methods', () => {
  it('no web code captures or calls the Storage methods around ui-prefs-sync', () => {
    const root = path.resolve(__dirname, '../../web/src')
    const hits: string[] = []
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (/\.(ts|tsx)$/.test(e.name) && !p.endsWith(path.join('utils', 'ui-prefs-sync.ts'))) {
          const text = fs.readFileSync(p, 'utf8')
          if (/Storage\.prototype\.(getItem|setItem|removeItem)|\.(getItem|setItem|removeItem)\.(call|apply|bind)\(/.test(text)) hits.push(path.relative(root, p))
        }
      }
    }
    walk(root)
    expect(hits, 'read and write localStorage through localStorage.getItem/setItem, so a write the browser drops is still this page\'s (ui-prefs-sync.ts)').toEqual([])
  })
})
