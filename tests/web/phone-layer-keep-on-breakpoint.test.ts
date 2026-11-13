/**
 * Leaving phone layout must not close a persistent layer (2026-11-07: a resize from
 * 760 to 1400 px called every layer's onClose, which closed the session, cleared its
 * view and the open file, and dropped the draft). The store drops such a layer's
 * history entry but keeps its owner's state (`keepOnBreakpoint`,
 * web/src/hooks/usePhoneOverlayHistory.ts).
 *
 * 1. Source guard: every phone layer call in web/src is classified; a persistent one
 *    (session, viewer/board, file, draft, chat) passes keepOnBreakpoint: true, and a
 *    new call fails here until it is classified.
 * 2. Mounted: the real hook and store under React, a real media change, owners whose
 *    state lives in the parent: the kept state survives, a menu still closes.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { parseHTML } from 'linkedom'
import { createElement, act, useState, Fragment } from '../../web/node_modules/react/index.js'
import { createRoot, type Root } from '../../web/node_modules/react-dom/client.js'

const WEB = path.resolve(import.meta.dirname, '../../web/src')

// ---------------------------------------------------------------------------
// Every phone layer call, read from source.

interface LayerCall { file: string; kindExpr: string; kinds: string[]; keep: 'true' | 'pass' | 'none' | 'other'; parent: string | null }

function listFiles(dir: string, out: string[] = []): string[] {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) listFiles(p, out)
    else if (/\.(tsx?|jsx?)$/.test(ent.name)) out.push(p)
  }
  return out
}

function readCalls(): { calls: LayerCall[]; unread: string[] } {
  const calls: LayerCall[] = []
  const unread: string[] = []
  for (const abs of listFiles(WEB)) {
    const src = readFileSync(abs, 'utf8')
    const file = path.relative(WEB, abs).split(path.sep).join('/')
    for (const m of src.matchAll(/\b(usePhoneOverlay|usePhoneLayerWithBar)\(/g)) {
      const at = m.index!
      if (/function\s+$/.test(src.slice(Math.max(0, at - 12), at))) continue // the definition
      let i = at + m[0].length
      while (/\s/.test(src[i])) i += 1
      if (src[i] !== '{') { unread.push(`${file}:${src.slice(0, at).split('\n').length}`); continue }
      let depth = 0
      let j = i
      for (; j < src.length; j += 1) {
        if (src[j] === '{') depth += 1
        else if (src[j] === '}' && --depth === 0) break
      }
      const text = src.slice(i, j + 1)
      const kindExpr = text.match(/\bkind:\s*([^,\n}]+)/)?.[1].trim() ?? ''
      const kinds = [...kindExpr.matchAll(/'([\w-]+)'/g)].map((k) => k[1])
      const keep = /\bkeepOnBreakpoint:\s*true\b/.test(text) ? 'true'
        : /\bkeepOnBreakpoint:\s*o\.keepOnBreakpoint\b/.test(text) ? 'pass'
          : /keepOnBreakpoint/.test(text) ? 'other' : 'none'
      const parent = text.match(/\bparentId:\s*([^,\n]+)/)?.[1].trim() ?? null
      calls.push({ file, kindExpr, kinds, keep, parent })
    }
  }
  return { calls, unread }
}

/** Kinds whose owner state must outlive a resize, wherever they are registered. */
const PERSISTENT_KINDS = ['session', 'draft', 'chat', 'file', 'board']

/** Every call, by `<file> <kind expression>`: keep, close (menus, sheets, pages), or the wrapper. */
const CLASSIFIED: Record<string, 'true' | 'none' | 'pass'> = {
  "components/sessions/SessionPanel.tsx 'session'": 'true',
  "components/sessions/SessionPanel.tsx activeView === 'board' ? 'board' : 'viewer'": 'true',
  "components/sessions/SessionFileExplorer.tsx 'file'": 'true',
  "components/sessions/DraftSessionPanel.tsx 'draft'": 'true',
  "components/chat/AskWalnutSlot.tsx 'chat'": 'true',
  // The desktop shows the same task detail modal, so a wider window keeps it open.
  "components/tasks/TaskDetailModal.tsx 'task-detail'": 'true',
  // A plugin's dialog is its own centred modal on the desktop too: a wider window keeps it.
  "plugins/PluginDialogHost.tsx 'sheet'": 'true',
  'components/sessions/phone-session-layer.tsx o.kind': 'pass',
  "components/chat/AskWalnutSlot.tsx 'asks'": 'none',
  "components/layout/AppShell.tsx 'drawer'": 'none',
  "components/common/NotificationPanel.tsx 'notifications'": 'none',
  "components/common/PhoneConfirmSheet.tsx 'sheet'": 'none',
  "components/tasks/PhonePhaseSheet.tsx 'sheet'": 'none',
  "components/tasks/PhoneSearchLayer.tsx 'search'": 'none',
  "components/settings/usePhoneSettingsPane.ts 'settings-pane'": 'none',
  "components/sessions/PromptCards.tsx 'plan'": 'none',
  "components/notes/usePhoneNoteLayer.tsx 'note'": 'none',
  "pages/CalendarPage.tsx 'calendar-tasks'": 'none',
  "apps/mail/MailReader.tsx 'viewer'": 'none',
}

const { calls, unread } = readCalls()
const keyOf = (c: LayerCall) => `${c.file} ${c.kindExpr}`

describe('source guard: which phone layers survive leaving phone layout', () => {
  it('reads every call (an object literal argument)', () => {
    expect(unread).toEqual([])
    expect(calls.length).toBeGreaterThanOrEqual(Object.keys(CLASSIFIED).length)
  })

  it('every call is classified, and every classified call still exists', () => {
    const found = calls.map(keyOf)
    expect(found.filter((k) => !(k in CLASSIFIED)), 'new phone layer: classify it here (keep or close on a resize)').toEqual([])
    expect(Object.keys(CLASSIFIED).filter((k) => !found.includes(k)), 'stale entry').toEqual([])
  })

  it('each call does what its class says', () => {
    for (const c of calls) expect(c.keep, keyOf(c)).toBe(CLASSIFIED[keyOf(c)])
  })

  it('a persistent kind keeps its state wherever it is registered', () => {
    for (const c of calls) {
      if (c.keep === 'pass') continue
      if (c.kinds.some((k) => PERSISTENT_KINDS.includes(k))) expect(c.keep, keyOf(c)).toBe('true')
    }
  })

  it('the wrapper hands keepOnBreakpoint to the store', () => {
    const src = readFileSync(path.join(WEB, 'components/sessions/phone-session-layer.tsx'), 'utf8')
    expect(src).toMatch(/keepOnBreakpoint\?:\s*boolean/)
  })
})

/** Calls that sit on another layer, by `<file> <kind expression>`, and the parent they name. */
const PARENTED: Record<string, string> = {
  "components/sessions/SessionPanel.tsx activeView === 'board' ? 'board' : 'viewer'": 'phoneLayer ? `session:${sessionId}` : phoneHostSlot',
  "components/sessions/SessionFileExplorer.tsx 'file'": 'phoneParentId',
  'components/sessions/phone-session-layer.tsx o.kind': 'o.parentId',
}

describe('source guard: a child layer registers after its parent', () => {
  const read = (rel: string) => readFileSync(path.join(WEB, rel), 'utf8')

  it('every call naming a parent is listed with that parent, and no other call names one', () => {
    for (const c of calls) expect(c.parent, keyOf(c)).toBe(PARENTED[keyOf(c)] ?? null)
    for (const k of Object.keys(PARENTED)) expect(calls.some((c) => keyOf(c) === k), `stale ${k}`).toBe(true)
  })

  it('the store gates a layer on its parent, and the wrapper passes it through', () => {
    const store = read('hooks/usePhoneOverlayHistory.ts')
    expect(store).toMatch(/parentId\?:\s*string;/)
    expect(store).toMatch(/const active = o\.open && phone && parentOpen\b/)
    expect(store).toMatch(/isPhoneOverlayOpen\(parentId\)/)
    expect(read('components/sessions/phone-session-layer.tsx')).toMatch(/parentId\?:\s*string;/)
  })

  it('SessionPanel hands its Files view layer id to the explorer it hosts; standalone explorers are not gated', () => {
    const panel = read('components/sessions/SessionPanel.tsx')
    expect(panel).toMatch(/const phoneViewerId = activeView === 'board' \? `board:\$\{session\?\.taskId \?\? sessionId\}` : `viewer:\$\{activeView \?\? 'none'\}:\$\{sessionId\}`;/)
    expect(panel).toMatch(/usePhoneLayerWithBar\(\{\s*id: phoneViewerId,/)
    const explorers = [...panel.matchAll(/<SessionFileExplorer\b[\s\S]*?\/>/g)].map((m) => m[0])
    expect(explorers).toHaveLength(1)
    expect(explorers[0]).toMatch(/phoneParentId=\{phoneLayer \|\| phoneHostSlot \? phoneViewerId : undefined\}/)
    expect(read('components/sessions/SessionFileExplorer.tsx')).toMatch(/phoneParentId\?:\s*string;/)
    // Outside a session panel the explorer has no layer below it.
    for (const rel of ['components/common/FileViewer.tsx', 'plugins/views.tsx']) expect(read(rel), rel).not.toContain('phoneParentId')
  })
})

// ---------------------------------------------------------------------------
// Mounted: linkedom, a phone media query that flips, an async history.

let doc: Document
let win: Record<string, unknown> & { dispatchEvent: (e: Event) => boolean; Event: typeof Event }
let phoneNow = true
const mediaListeners = new Set<(ev: { matches: boolean }) => void>()
const savedGlobals: Record<string, unknown> = {}

class FakeHistory {
  entries: unknown[] = [null]
  i = 0
  get state(): unknown { return this.entries[this.i] }
  pushState(s: unknown): void { this.entries.splice(this.i + 1); this.entries.push(s); this.i += 1 }
  replaceState(s: unknown): void { this.entries[this.i] = s }
  back(): void { this.go(-1) }
  go(n: number): void {
    setTimeout(() => {
      this.i = Math.max(0, Math.min(this.entries.length - 1, this.i + n))
      const ev = new win.Event('popstate')
      Object.defineProperty(ev, 'state', { value: this.state })
      win.dispatchEvent(ev)
    }, 0)
  }
}

type Store = typeof import('../../web/src/hooks/usePhoneOverlayHistory')
type Layer = typeof import('../../web/src/components/sessions/phone-session-layer')
type Phone = typeof import('../../web/src/hooks/usePhoneLayout')
let store: Store
let layer: Layer
let phoneMod: Phone

beforeAll(async () => {
  const dom = parseHTML('<!DOCTYPE html><html><head></head><body></body></html>')
  const g = globalThis as unknown as Record<string, unknown>
  for (const k of ['window', 'document', 'history', 'location', 'matchMedia', 'IS_REACT_ACT_ENVIRONMENT']) savedGlobals[k] = g[k]
  g.window = dom.window
  g.document = dom.document
  g.IS_REACT_ACT_ENVIRONMENT = true
  win = dom.window as unknown as typeof win
  win.history = new FakeHistory()
  win.location = { href: 'http://localhost/' }
  win.matchMedia = (query: string) => ({
    get matches() { return query.includes('max-width: 768px') ? phoneNow : false },
    media: query,
    addEventListener: (_t: string, l: (ev: { matches: boolean }) => void) => { mediaListeners.add(l) },
    removeEventListener: (_t: string, l: (ev: { matches: boolean }) => void) => { mediaListeners.delete(l) },
  })
  doc = dom.document as unknown as Document
  store = await import('../../web/src/hooks/usePhoneOverlayHistory')
  layer = await import('../../web/src/components/sessions/phone-session-layer')
  phoneMod = await import('../../web/src/hooks/usePhoneLayout')
})

afterAll(() => {
  const g = globalThis as unknown as Record<string, unknown>
  for (const [k, v] of Object.entries(savedGlobals)) g[k] = v
})

function setPhone(v: boolean): void {
  phoneNow = v
  for (const l of [...mediaListeners]) l({ matches: v })
}

/** What each layer passes, as the source says (the guard above pins the source). */
const keepAt = (file: string, kind: string): boolean => {
  const c = calls.find((x) => x.file === file && x.kinds.includes(kind))
  if (!c) throw new Error(`no ${kind} layer in ${file}`)
  return c.keep === 'true'
}
const SOURCE_KEEP = {
  session: keepAt('components/sessions/SessionPanel.tsx', 'session'),
  viewer: keepAt('components/sessions/SessionPanel.tsx', 'viewer'),
  file: keepAt('components/sessions/SessionFileExplorer.tsx', 'file'),
  draft: keepAt('components/sessions/DraftSessionPanel.tsx', 'draft'),
  chat: keepAt('components/chat/AskWalnutSlot.tsx', 'chat'),
}
type KeepMap = typeof SOURCE_KEEP
const NO_KEEP: KeepMap = { session: false, viewer: false, file: false, draft: false, chat: false }

function L({ id, kind, active, keep, onClose }: {
  id: string; kind: Parameters<Layer['usePhoneLayerWithBar']>[0]['kind']; active: boolean; keep: boolean; onClose: () => void
}) {
  layer.usePhoneLayerWithBar({ id, kind, active, title: id, withAction: false, keepOnBreakpoint: keep, onClose })
  return null
}

const SID = 's-keep-1'
const FILE = '/repo/src/a.ts'
const DRAFT_TEXT = 'half typed draft words'

/** Owners whose open state lives in the parent, closed by their layer's onClose like the product's. */
function App({ keep }: { keep: KeepMap }) {
  const phone = phoneMod.usePhoneLayout()
  const [sessionOpen, setSessionOpen] = useState(true)
  const [view, setView] = useState<string | null>('files')
  const [file, setFile] = useState<string | null>(FILE)
  const [draft, setDraft] = useState<string | null>(DRAFT_TEXT)
  const [chatShown, setChatShown] = useState(true)
  const [sheet, setSheet] = useState(true)
  return createElement(Fragment, null,
    createElement(L, { id: `session:${SID}`, kind: 'session', active: phone && sessionOpen, keep: keep.session, onClose: () => setSessionOpen(false) }),
    createElement(L, { id: `viewer:${view ?? 'none'}:${SID}`, kind: 'viewer', active: phone && sessionOpen && !!view, keep: keep.viewer, onClose: () => setView(null) }),
    createElement(L, { id: `file:${file ?? ''}`, kind: 'file', active: phone && !!file, keep: keep.file, onClose: () => setFile(null) }),
    createElement(L, { id: 'draft:d1', kind: 'draft', active: phone && draft !== null, keep: keep.draft, onClose: () => setDraft(null) }),
    createElement(L, { id: 'chat', kind: 'chat', active: phone && chatShown, keep: keep.chat, onClose: () => setChatShown(false) }),
    // A temporary layer (a menu sheet): it still closes on a resize.
    createElement(L, { id: 'sheet:menu', kind: 'sheet', active: phone && sheet, keep: false, onClose: () => setSheet(false) }),
    createElement('div', { 'data-session': sessionOpen ? 'open' : 'closed' }),
    createElement('div', { 'data-view': view ?? 'none' }),
    createElement('div', { 'data-file': file ?? 'none' }),
    createElement('div', { 'data-draft': draft === null ? 'gone' : 'kept' }, draft ?? ''),
    createElement('div', { 'data-chat': chatShown ? 'shown' : 'hidden' }),
    createElement('div', { 'data-sheet': sheet ? 'open' : 'closed' }),
  )
}

let root: Root | null = null
let container: Element | null = null
const errors: unknown[] = []
const settle = () => new Promise((r) => setTimeout(r, 20))

async function step(fn: () => void): Promise<void> {
  try { await act(async () => { fn(); await settle() }) } catch (e) { errors.push(e) }
}

async function mount(keep: KeepMap): Promise<void> {
  // The product installs the store's listener at AppShell mount, before any React subscriber.
  store.installPhoneOverlayHistory()
  container = doc.createElement('div')
  doc.body.appendChild(container)
  root = createRoot(container, { onUncaughtError: (e: unknown) => { errors.push(e) }, onCaughtError: (e: unknown) => { errors.push(e) } })
  await step(() => root!.render(createElement(App, { keep })))
}

const attr = (name: string) => container!.querySelector(`[data-${name}]`)?.getAttribute(`data-${name}`)
const draftValue = () => container!.querySelector('[data-draft]')?.textContent
const ALL_IDS = [`session:${SID}`, `viewer:files:${SID}`, `file:${FILE}`, 'draft:d1', 'chat', 'sheet:menu']
const KEPT_IDS = ALL_IDS.filter((id) => id !== 'sheet:menu')
const hist = () => win.history as FakeHistory

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); await settle() })
  root = null
  container?.remove()
  container = null
  expect(store.phoneOverlayIds()).toEqual([])
  store.__resetPhoneOverlaysForTest()
  hist().entries = [null]
  hist().i = 0
  phoneNow = true
  errors.length = 0
})

describe('mounted: a resize out of phone layout keeps the owners’ state', () => {
  it('red control: with no keepOnBreakpoint the resize deletes the session, view, file and draft', async () => {
    await mount(NO_KEEP)
    expect(store.phoneOverlayIds()).toEqual(ALL_IDS)
    await step(() => setPhone(false))
    expect(errors).toEqual([])
    expect(attr('session')).toBe('closed')
    expect(attr('file')).toBe('none')
    expect(attr('draft')).toBe('gone')
    expect(attr('chat')).toBe('hidden')
  })

  it('the source’s classes keep session, view, file, draft text and chat; the menu sheet closes; history is clean', async () => {
    await mount(SOURCE_KEEP)
    expect(store.phoneOverlayIds()).toEqual(ALL_IDS)
    expect(hist().i).toBe(ALL_IDS.length)

    await step(() => setPhone(false))
    expect(errors).toEqual([])
    expect(store.phoneOverlayIds()).toEqual([])
    expect(attr('session')).toBe('open')
    expect(attr('view')).toBe('files')
    expect(attr('file')).toBe(FILE)
    expect(attr('draft')).toBe('kept')
    expect(draftValue()).toBe(DRAFT_TEXT)
    expect(attr('chat')).toBe('shown')
    expect(attr('sheet')).toBe('closed')
    // Every entry the layers pushed is off the browser's stack: no ghost back.
    expect(hist().i).toBe(0)
    expect(store.markerDepth(hist().state)).toBe(0)
  })

  it('back to phone and out again: the kept layers come back, nothing is closed, history never grows', async () => {
    await mount(SOURCE_KEEP)
    for (let round = 0; round < 2; round += 1) {
      await step(() => setPhone(false))
      expect(store.phoneOverlayIds()).toEqual([])
      expect(hist().i).toBe(0)
      await step(() => setPhone(true))
      expect(errors).toEqual([])
      expect(store.phoneOverlayIds()).toEqual(KEPT_IDS)
      expect(hist().i).toBe(KEPT_IDS.length)
      expect(hist().entries.length).toBe(KEPT_IDS.length + 1)
    }
    expect(attr('file')).toBe(FILE)
    expect(draftValue()).toBe(DRAFT_TEXT)
    expect(attr('view')).toBe('files')
  })
})

// ---------------------------------------------------------------------------
// Nested, as the product nests them: a session column (its session layer and its
// Files view layer) hosting the explorer (its file layer). React runs the
// explorer's effects before the panel's, so without parentId the file would be
// pushed under the session.

const NSID = 's-nested-1'
const NSESSION = `session:${NSID}`
const NVIEWER = `viewer:files:${NSID}`
const NFILE = `file:${FILE}`

function NExplorer({ parentId }: { parentId?: string }) {
  const phone = phoneMod.usePhoneLayout()
  const [file, setFile] = useState<string | null>(FILE)
  layer.usePhoneLayerWithBar({
    id: `file:${file ?? ''}`, kind: 'file', active: phone && !!file, title: 'src', withAction: false,
    keepOnBreakpoint: SOURCE_KEEP.file, parentId, onClose: () => setFile(null),
  })
  return createElement('div', { 'data-nfile': file ?? 'tree' })
}

/** SessionPanel's two layers and its explorer, with the parents the source passes (or none: red control). */
function NPanel({ parents, sid = NSID }: { parents: boolean; sid?: string }) {
  const phone = phoneMod.usePhoneLayout()
  const [open, setOpen] = useState(true)
  const [view, setView] = useState<string | null>('files')
  const phoneLayer = phone && open
  layer.usePhoneLayerWithBar({
    id: `session:${sid}`, kind: 'session', active: phoneLayer, title: 'Session', keepOnBreakpoint: SOURCE_KEEP.session,
    onClose: () => setOpen(false),
  })
  const viewerId = `viewer:${view ?? 'none'}:${sid}`
  layer.usePhoneLayerWithBar({
    id: viewerId, kind: 'viewer', active: phoneLayer && !!view, title: 'Files', withAction: false,
    keepOnBreakpoint: SOURCE_KEEP.viewer, parentId: parents ? `session:${sid}` : undefined, onClose: () => setView(null),
  })
  return createElement(Fragment, null,
    createElement('div', { 'data-nsession': open ? 'open' : 'closed' }),
    createElement('div', { 'data-nview': view ?? 'chat' }),
    open && view === 'files' ? createElement(NExplorer, { parentId: parents && phoneLayer ? viewerId : undefined }) : null,
  )
}

async function mountNested(parents: boolean): Promise<void> {
  store.installPhoneOverlayHistory()
  container = doc.createElement('div')
  doc.body.appendChild(container)
  root = createRoot(container, { onUncaughtError: (e: unknown) => { errors.push(e) }, onCaughtError: (e: unknown) => { errors.push(e) } })
  await step(() => root!.render(createElement(NPanel, { parents })))
}

/** A page reload: the browser kept a stale marker on the entry, over a previous route. */
function reloadedHistory(): void {
  hist().entries = [{ key: 'prev' }, { key: 'home', walnutOverlay: { id: NFILE, kind: 'file', depth: 3 } }]
  hist().i = 1
}

const key = () => (hist().state as { key?: string } | null)?.key

/** Back three times: the file to its tree, the view to the chat, then the session. */
async function backSequence(sid = NSID): Promise<void> {
  await step(() => hist().back())
  expect(store.phoneOverlayIds()).toEqual([`session:${sid}`, `viewer:files:${sid}`])
  expect(attr('nfile')).toBe('tree')
  expect(attr('nview')).toBe('files')
  await step(() => hist().back())
  expect(store.phoneOverlayIds()).toEqual([`session:${sid}`])
  expect(attr('nview')).toBe('chat')
  expect(attr('nsession')).toBe('open')
  await step(() => hist().back())
  expect(store.phoneOverlayIds()).toEqual([])
  expect(attr('nsession')).toBe('closed')
  expect(hist().i).toBe(1)
  expect(key()).toBe('home')
  expect(errors).toEqual([])
}

describe('mounted nested: session, its Files view, its open file', () => {
  it('red control: without parentId a phone reload pushes the file under the session', async () => {
    reloadedHistory()
    await mountNested(false)
    expect(store.phoneOverlayIds()).toEqual([NFILE, NSESSION, NVIEWER])
  })

  it('phone reload: session, view, file in that order; Back closes file, then view, then session, and stops at home', async () => {
    reloadedHistory()
    await mountNested(true)
    expect(errors).toEqual([])
    expect(store.phoneOverlayIds()).toEqual([NSESSION, NVIEWER, NFILE])
    expect(hist().i).toBe(4)
    expect(store.markerDepth(hist().entries[1])).toBe(0) // the stale marker is gone
    expect(store.markerId(hist().state)).toBe(NFILE)
    await backSequence()
  })

  it('rotate to desktop and back: all three kept, re-registered in order, then the same Back sequence', async () => {
    reloadedHistory()
    await mountNested(true)
    await step(() => setPhone(false))
    expect(errors).toEqual([])
    expect(store.phoneOverlayIds()).toEqual([])
    expect(hist().i).toBe(1)
    expect(key()).toBe('home')
    expect(attr('nsession')).toBe('open')
    expect(attr('nview')).toBe('files')
    expect(attr('nfile')).toBe(FILE)

    await step(() => setPhone(true))
    expect(errors).toEqual([])
    expect(store.phoneOverlayIds()).toEqual([NSESSION, NVIEWER, NFILE])
    expect(hist().i).toBe(4)
    await backSequence()
  })

  it('a UI close in flight when the window widens: the file closes, the rest is kept, history stops at home', async () => {
    reloadedHistory()
    await mountNested(true)
    // The bar's Back goes through history: its back has not landed when the resize fires.
    await step(() => { expect(store.closeTopPhoneOverlay()).toBe(true); setPhone(false) })
    expect(errors).toEqual([])
    expect(hist().i).toBe(1)
    expect(key()).toBe('home')
    expect(attr('nfile')).toBe('tree')
    expect(attr('nsession')).toBe('open')
    expect(attr('nview')).toBe('files')
  })

  it('a session replaced in its column (MainPage key={sid}): one unwind, the new chain right above home, Back walks it to home', async () => {
    reloadedHistory()
    await mountNested(true)
    expect(hist().i).toBe(4)
    const SID2 = 's-nested-2'
    // Old session, view and file unmount in one commit; the new column mounts (same file path: same id).
    await step(() => root!.render(createElement(NPanel, { key: SID2, parents: true, sid: SID2 })))
    await expect.poll(async () => {
      await step(() => {})
      return hist().entries.slice(2).map((s) => store.markerId(s))
    }).toEqual([`session:${SID2}`, `viewer:files:${SID2}`, NFILE])
    expect(errors).toEqual([])
    expect(store.phoneOverlayIds()).toEqual([`session:${SID2}`, `viewer:files:${SID2}`, NFILE])
    expect(hist().i).toBe(4)
    expect(hist().entries.length).toBe(5)
    expect(hist().entries.slice(2).map((s) => store.markerId(s))).toEqual([`session:${SID2}`, `viewer:files:${SID2}`, NFILE])
    await backSequence(SID2)
  })
})
