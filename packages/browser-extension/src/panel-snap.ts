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
/** `page` and `quote`: what a person's message took from the page, drawn in its bubble as the view draws them. */
type Msg = { role: 'user' | 'assistant'; text: string; page?: string; quote?: string }
/** An ask to continue, as the view's Continue list showed it. */
export type ContRow = { title: string; line: string; time: string; needs: boolean }
/**
 * One page's conversation as the Ask view showed it. `askTitle`, `agent`, `placeholder`,
 * `continue`, `suggestions` and `pageOn` come from a Walnut whose view says them; an older one's
 * snapshot has the messages alone.
 */
export interface AskSnap {
  at: number; title: string; host: string; messages: Msg[]
  askTitle?: string; agent?: string; placeholder?: string; cont?: ContRow[]; suggestions?: string[]; pageOn?: boolean
  /** `suggestionIcons[i]`: the icon of `suggestions[i]` (SUGGESTION_ICONS), '' for none. */
  suggestionIcons?: string[]
}
type Row = { title: string; line: string; state: string }
export interface TasksSnap { at: number; sections: Array<{ title: string; count: number; rows: Row[] }> }
/** The last Continue list and suggestions any page showed: a page seen for the first time, and the popup, draw these. */
export interface AskShell { at: number; agent?: string; cont?: ContRow[]; suggestions?: string[]; suggestionIcons?: string[] }

/** The suggestion icons a view names (web/src/components/common/Icons.tsx); any other name draws none. */
export const SUGGESTION_ICONS = ['search', 'calendar', 'clock'] as const
interface Snaps { ask?: Record<string, AskSnap>; tasks?: TasksSnap; shell?: AskShell }

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
    if (!text) return []
    const user = o?.role === 'user'
    const page = user ? str(o?.page, 200) : ''
    const quote = user ? str(o?.quote, 300) : ''
    return [{ role: user ? 'user' : 'assistant', text, ...(page ? { page } : {}), ...(quote ? { quote } : {}) }]
  })
  const cont = Array.isArray(r.continue) ? r.continue.slice(0, 6).flatMap((x): ContRow[] => {
    const o = x as Record<string, unknown> | null
    const title = str(o?.title, 200)
    return title ? [{ title, line: str(o?.line, 200), time: str(o?.time, 30), needs: o?.needs === true }] : []
  }) : undefined
  const pairs = Array.isArray(r.suggestions) ? r.suggestions.slice(0, 3).map((x, i) => ({
    label: str(x, 60),
    icon: Array.isArray(r.suggestionIcons) && (SUGGESTION_ICONS as readonly string[]).includes(String(r.suggestionIcons[i])) ? String(r.suggestionIcons[i]) : '',
  })).filter((p) => p.label) : undefined
  const suggestions = pairs?.map((p) => p.label)
  const suggestionIcons = pairs?.some((p) => p.icon) ? pairs.map((p) => p.icon) : undefined
  return {
    at: now, title: str(r.title, 300), host: str(r.host, 200), messages,
    ...(str(r.askTitle, 200) ? { askTitle: str(r.askTitle, 200) } : {}),
    ...(str(r.agent, 60) ? { agent: str(r.agent, 60) } : {}),
    ...(str(r.placeholder, 120) ? { placeholder: str(r.placeholder, 120) } : {}),
    ...(cont ? { cont } : {}),
    ...(suggestions ? { suggestions } : {}),
    ...(suggestionIcons ? { suggestionIcons } : {}),
    ...(typeof r.pageOn === 'boolean' ? { pageOn: r.pageOn } : {}),
  }
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
    if (clean.cont || clean.suggestions || clean.agent) {
      all.shell = { at: now, ...(all.shell ?? {}), ...(clean.agent ? { agent: clean.agent } : {}), ...(clean.cont ? { cont: clean.cont } : {}), ...(clean.suggestions ? { suggestions: clean.suggestions, suggestionIcons: clean.suggestionIcons } : {}) }
      all.shell.at = now
    }
  } else {
    const clean = cleanTasks(snap, opts.counts, now)
    if (!clean) return
    all.tasks = clean
  }
  await ext.storage.local.set({ [STORE]: all })
}

/** The Ask view's shell of last time (its Continue list, suggestions, agent), or null. */
export async function shellOf(now = Date.now()): Promise<AskShell | null> {
  const s = (await readAll()).shell
  return s && now - s.at < MAX_AGE_MS ? s : null
}

export async function snapOf(view: SnapView, url?: string, now = Date.now()): Promise<AskSnap | TasksSnap | null> {
  const all = await readAll()
  const s = view === 'ask' ? (url ? all.ask?.[snapKeyOf(url)] : undefined) : all.tasks
  return s && now - s.at < MAX_AGE_MS ? s : null
}

/** The drawing: the same places as the view it stands for, in plain text. */
/** The three-tab panel's drawing (panel-tabs.ts); the Ask panel draws its own (panel-look.ts). */
export function drawSnap(view: SnapView, snap: AskSnap | TasksSnap): HTMLElement {
  if (view === 'ask') {
    const s = snap as AskSnap
    return h('div', { class: 'panel-snap panel-snap-ask', 'data-testid': 'panel-snap', 'aria-hidden': 'true' },
      h('div', { class: 'panel-snap-head' },
        h('div', { class: 'panel-snap-title' }, s.title || s.host),
        h('div', { class: 'panel-snap-host' }, s.host)),
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
