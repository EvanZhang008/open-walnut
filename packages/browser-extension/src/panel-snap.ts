/**
 * What the side panel's Ask and Tasks views showed last time, drawn by the panel page itself while
 * the view loads again (Walnut's whole page starts in its frame, which takes about a second; this
 * page draws at once). The view sends its words as it shows them (web/src/popout/ext-snapshot.ts)
 * and says `shown` once its own content is up, and the drawing goes.
 *
 * Words only, kept in storage.local, drawn with textContent (dom.ts `h`), never as markup; a
 * conversation is kept per page (its address without the #part), the Tasks lists once. They are
 * the connected Walnut's words: kept only while a Walnut is connected (the panel's `panelServer`),
 * and removed with it on a disconnect (panel-data.ts). Passwords is never drawn from a copy.
 */
import { ext } from './ext'
import { h } from './dom'
import { PANEL_SERVER_KEY, PANEL_SNAPS_KEY } from './panel-data'

export type SnapView = 'ask' | 'tasks'
type Msg = { role: 'user' | 'assistant'; text: string }
export interface AskSnap { at: number; title: string; host: string; messages: Msg[] }
type Row = { title: string; line: string; state: string }
export interface TasksSnap { at: number; sections: Array<{ title: string; count: number; rows: Row[] }> }
interface Snaps { ask?: Record<string, AskSnap>; tasks?: TasksSnap }

const STORE = PANEL_SNAPS_KEY
const ASK_KEEP = 30
/** Older than this, what it shows says too little of now to draw. */
const MAX_AGE_MS = 14 * 24 * 3600_000

/** One conversation per page: its address without the #part (web/src/popout/ext-panel-model.ts pageKey). */
export function snapKeyOf(url: string): string {
  try {
    const u = new URL(url)
    return `web:${u.origin}${u.pathname}${u.search}`
  } catch {
    return `web:${url}`
  }
}

const str = (v: unknown, n: number): string => (typeof v === 'string' ? v.slice(0, n) : '')

function cleanAsk(raw: unknown, now: number): AskSnap | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const messages = (Array.isArray(r.messages) ? r.messages : []).slice(-6).flatMap((m): Msg[] => {
    const o = m as Record<string, unknown> | null
    const text = str(o?.text, 800)
    return text ? [{ role: o?.role === 'user' ? 'user' : 'assistant', text }] : []
  })
  return { at: now, title: str(r.title, 300), host: str(r.host, 200), messages }
}

function cleanTasks(raw: unknown, counts: unknown, now: number): TasksSnap | null {
  if (!raw || typeof raw !== 'object') return null
  const sections = (Array.isArray((raw as { sections?: unknown }).sections) ? (raw as { sections: unknown[] }).sections : []).slice(0, 4)
  const n = Array.isArray(counts) ? counts : []
  return {
    at: now,
    sections: sections.map((s, i) => {
      const o = s as Record<string, unknown> | null
      const rows = (Array.isArray(o?.rows) ? o!.rows as unknown[] : []).slice(0, 20).map((x) => {
        const r = x as Record<string, unknown> | null
        return { title: str(r?.title, 200), line: str(r?.line, 200), state: /^[a-z]{1,12}$/.test(String(r?.state)) ? String(r?.state) : '' }
      }).filter((r) => r.title)
      return { title: str(o?.title, 40), count: typeof n[i] === 'number' ? n[i] as number : rows.length, rows }
    }),
  }
}

async function readAll(): Promise<Snaps> {
  const v = (await ext.storage.local.get(STORE))[STORE]
  return v && typeof v === 'object' ? v as Snaps : {}
}

/** One write at a time: two views writing at once must not drop each other's words. */
let writing: Promise<void> = Promise.resolve()

/** Keep what a view says it shows (a view of the connected Walnut, checked by the caller). */
export function keepSnap(view: SnapView, snap: unknown, opts: { key?: unknown; counts?: unknown } = {}, now = Date.now()): Promise<void> {
  writing = writing.then(() => write(view, snap, opts, now)).catch(() => undefined)
  return writing
}

async function write(view: SnapView, snap: unknown, opts: { key?: unknown; counts?: unknown }, now: number): Promise<void> {
  // Disconnected meanwhile (panel-data.ts removed the server): nothing of that Walnut is kept.
  const server = (await ext.storage.local.get(PANEL_SERVER_KEY))[PANEL_SERVER_KEY]
  if (typeof server !== 'string' || !server) return
  const all = await readAll()
  if (view === 'ask') {
    const key = str(opts.key, 4100)
    const clean = cleanAsk(snap, now)
    if (!key || !clean) return
    const ask = { ...(all.ask ?? {}), [key]: clean }
    const kept = Object.entries(ask).sort((a, b) => b[1].at - a[1].at).slice(0, ASK_KEEP)
    all.ask = Object.fromEntries(kept)
  } else {
    const clean = cleanTasks(snap, opts.counts, now)
    if (!clean) return
    all.tasks = clean
  }
  await ext.storage.local.set({ [STORE]: all })
}

export async function snapOf(view: SnapView, url?: string, now = Date.now()): Promise<AskSnap | TasksSnap | null> {
  const all = await readAll()
  const s = view === 'ask' ? (url ? all.ask?.[snapKeyOf(url)] : undefined) : all.tasks
  return s && now - s.at < MAX_AGE_MS ? s : null
}

/** The drawing: the same places as the view it stands for, in plain text. */
export function drawSnap(view: SnapView, snap: AskSnap | TasksSnap, shape: 'tabs' | 'ask' = 'tabs'): HTMLElement {
  if (view === 'ask') {
    const s = snap as AskSnap
    // `ask`: the panel that opens as Walnut's Ask (panel-ask.ts), whose header is ≡, the title, "Ask Walnut".
    return h('div', { class: `panel-snap panel-snap-ask${shape === 'ask' ? ' is-ask' : ''}`, 'data-testid': 'panel-snap', 'aria-hidden': 'true' },
      h('div', { class: 'panel-snap-head' },
        h('div', { class: 'panel-snap-title' }, s.title || s.host),
        h('div', { class: 'panel-snap-host' }, shape === 'ask' ? 'Ask Walnut' : s.host)),
      h('div', { class: 'panel-snap-chat' },
        ...s.messages.map((m) => h('div', { class: `panel-snap-msg is-${m.role}` }, m.text))),
      h('div', { class: 'panel-snap-composer' }, s.messages.length ? 'Ask a follow-up…' : 'Ask about this page…'))
  }
  const s = snap as TasksSnap
  // The view's own layout (PopoutExtTasks): its save row on top, then the sections; a Focus with no
  // task says so as the view does, so the drawing and the view never look like two pages.
  return h('div', { class: 'panel-snap panel-snap-tasks', 'data-testid': 'panel-snap', 'aria-hidden': 'true' },
    h('div', { class: 'panel-snap-save' }, h('span', { class: 'panel-snap-btn' }, 'Save this page as a task')),
    ...s.sections.map((sec) => h('section', {},
      h('h3', {}, sec.title, ' ', h('span', { class: 'panel-snap-count' }, String(sec.count))),
      ...(sec.rows.length === 0 && sec.title === 'Focus' ? [h('p', { class: 'panel-snap-empty' }, 'No Focus tasks.')] : []),
      ...sec.rows.map((r) => h('div', { class: 'panel-snap-task' },
        h('span', { class: `panel-snap-dot state-${r.state}` }),
        h('span', { class: 'panel-snap-task-text' },
          h('span', { class: 'panel-snap-task-title' }, r.title),
          h('span', { class: 'panel-snap-task-line' }, r.line)))))))
}
