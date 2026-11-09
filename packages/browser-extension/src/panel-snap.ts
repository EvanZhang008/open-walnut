/**
 * What the side panel's Ask and Tasks views showed last time, drawn by the panel page itself while
 * the view loads again (Walnut's whole page starts in its frame, which takes about a second; this
 * page draws at once). The view sends its words as it shows them (web/src/popout/ext-snapshot.ts)
 * and says `shown` once its own content is up, and the drawing goes.
 *
 * Words only, kept in storage.local, drawn with textContent (dom.ts `h`), never as markup; the
 * Ask view's open conversation is kept once per agent (`panel:agent:<id>`: one conversation per
 * agent, whatever the page), with the agent the Ask view was last on (it opens on the agent picked
 * last, in any window), so the drawing is that agent's and never another's; with no agent known it
 * draws the bare Ask (round 3 code review, item 3). The Tasks lists are kept once. They are
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
  /** The page it was shown on (snapKeyOf): on another page the view draws the page chip on. */
  pageKey?: string
  /** The composer's mode and model pills as they read, drawn on their own line over its bar. */
  pickers?: string[]
}
type Row = { title: string; line: string; state: string }
export interface TasksSnap { at: number; sections: Array<{ title: string; count: number; rows: Row[] }> }
/** An agent's last Continue list and suggestions: its new chat, and the popup, draw these. */
export interface AskShell { at: number; agent?: string; cont?: ContRow[]; suggestions?: string[]; suggestionIcons?: string[] }

/** The suggestion icons a view names (web/src/components/common/Icons.tsx); any other name draws none. */
export const SUGGESTION_ICONS = ['search', 'calendar', 'clock'] as const
/**
 * `agent`: the agent the Ask view said it is on last (its `agent` word), `shells` each agent's
 * shell. An older store's one `shell` (any agent's) is never drawn.
 */
/** The first page's task panel as it showed it (web/src/popout/ext-home-model.ts HomeSnap). */
export interface HomeSnap {
  at: number
  tabs: Array<{ label: string; count?: string; on?: boolean }>
  heading?: string
  rows: Array<{ title: string; meta: string; line: string; time: string; needs: boolean }>
}
/** The page the side panel's view shows: the first page, an ask, or a task opened there (with its title). */
export type PanelMode = 'home' | 'ask' | 'task'
export interface ModeKept { mode: PanelMode; title?: string; at: number }
interface Snaps {
  ask?: Record<string, AskSnap>; tasks?: TasksSnap; agent?: { id: string; name?: string; at: number }; shells?: Record<string, AskShell>
  home?: HomeSnap; mode?: ModeKept
}

const STORE = PANEL_SNAPS_KEY
const ASK_KEEP = 30
const SHELLS_KEEP = 12
/** Older than this, what it shows says too little of now to draw. */
const MAX_AGE_MS = 14 * 24 * 3600_000

/** The keys the Ask view keeps an agent's open conversation under (web/src/popout/ext-snapshot.ts PANEL_SNAP_PREFIX). */
export const ASK_AGENT_PREFIX = 'panel:agent:'
/** An agent as the view names it (PopoutExtPanel isAgentId). */
const AGENT_ID = /^[\w.-]{1,80}$/
export const agentAskKey = (agentId: string): string => `${ASK_AGENT_PREFIX}${agentId}`
const agentIdOf = (v: unknown): string => (typeof v === 'string' && AGENT_ID.test(v) ? v : '')

/** A page as the view names it: its address without the #part (web/src/popout/ext-panel-model.ts pageKey). */
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
  const pickers = Array.isArray(r.pickers) ? r.pickers.slice(0, 2).map((x) => str(x, 40)).filter(Boolean) : undefined
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
    ...(str(r.pageKey, 4100) ? { pageKey: str(r.pageKey, 4100) } : {}),
    ...(pickers?.length ? { pickers } : {}),
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

/** What the first page said it shows, cut to what a drawing holds; null for anything else. */
export function cleanHome(raw: unknown, now: number): HomeSnap | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const tabs = (Array.isArray(r.tabs) ? r.tabs : []).slice(0, 6).flatMap((x) => {
    const o = x as Record<string, unknown> | null
    const label = str(o?.label, 30)
    const count = str(o?.count, 8)
    return label ? [{ label, ...(count ? { count } : {}), ...(o?.on === true ? { on: true } : {}) }] : []
  })
  const rows = (Array.isArray(r.rows) ? r.rows : []).slice(0, 10).flatMap((x) => {
    const o = x as Record<string, unknown> | null
    const title = str(o?.title, 160)
    return title ? [{ title, meta: str(o?.meta, 60), line: str(o?.line, 160), time: str(o?.time, 20), needs: o?.needs === true }] : []
  })
  if (!tabs.length && !rows.length) return null
  const heading = str(r.heading, 40)
  return { at: now, tabs, ...(heading ? { heading } : {}), rows }
}

const MODES: readonly PanelMode[] = ['home', 'ask', 'task']
/** The view's page word, or null for anything else. */
export function cleanMode(mode: unknown, title: unknown, now: number): ModeKept | null {
  if (!MODES.includes(mode as PanelMode)) return null
  const t = mode === 'task' ? str(title, 200) : ''
  return { mode: mode as PanelMode, ...(t ? { title: t } : {}), at: now }
}

/** Keep the first page's words, or the page the view shows (a view of the connected Walnut, checked by the caller). */
export function keepHomeSnap(snap: unknown, now = Date.now()): Promise<void> {
  return keepOwn((all) => { const c = cleanHome(snap, now); if (!c) return false; all.home = c; return true })
}
export function keepMode(mode: unknown, title: unknown, now = Date.now()): Promise<void> {
  return keepOwn((all) => {
    const c = cleanMode(mode, title, now)
    if (!c || (all.mode?.mode === c.mode && (all.mode.title ?? '') === (c.title ?? ''))) return false
    all.mode = c
    return true
  })
}
function keepOwn(change: (all: Snaps) => boolean): Promise<void> {
  writing = writing.then(async () => {
    const server = (await ext.storage.local.get(PANEL_SERVER_KEY))[PANEL_SERVER_KEY]
    if (typeof server !== 'string' || !server) return
    const all = await readAll()
    if (change(all)) await ext.storage.local.set({ [STORE]: all })
  }).catch(() => undefined)
  return writing
}

/** The first page's words of last time, and the page the side panel's view was on (none: the first page). */
export async function homeOf(now = Date.now()): Promise<{ home: HomeSnap | null; mode: ModeKept | null }> {
  const all = await readAll()
  const home = all.home && now - all.home.at < MAX_AGE_MS ? all.home : null
  const mode = all.mode && MODES.includes(all.mode.mode) ? all.mode : null
  return { home, mode }
}

async function readAll(): Promise<Snaps> {
  const v = (await ext.storage.local.get(STORE))[STORE]
  return v && typeof v === 'object' ? v as Snaps : {}
}

/** One write at a time: two views writing at once must not drop each other's words. */
let writing: Promise<void> = Promise.resolve()

/** Keep what a view says it shows (a view of the connected Walnut, checked by the caller). */
export function keepSnap(view: SnapView, snap: unknown, opts: { key?: unknown; agentId?: unknown; counts?: unknown } = {}, now = Date.now()): Promise<void> {
  writing = writing.then(() => write(view, snap, opts, now)).catch(() => undefined)
  return writing
}

/** The Ask view said which agent it is on (`name` as its header names it): the next open draws that agent's words. */
export function keepAgent(agentId: unknown, now = Date.now(), name?: unknown): Promise<void> {
  const id = agentIdOf(agentId)
  const label = str(name, 60)
  if (!id) return writing
  writing = writing.then(async () => {
    const server = (await ext.storage.local.get(PANEL_SERVER_KEY))[PANEL_SERVER_KEY]
    if (typeof server !== 'string' || !server) return
    const all = await readAll()
    if (all.agent?.id === id && (all.agent.name ?? '') === label) return
    all.agent = { id, ...(label ? { name: label } : {}), at: now }
    await ext.storage.local.set({ [STORE]: all })
  }).catch(() => undefined)
  return writing
}

async function write(view: SnapView, snap: unknown, opts: { key?: unknown; agentId?: unknown; counts?: unknown }, now: number): Promise<void> {
  // Disconnected meanwhile (panel-data.ts removed the server): nothing of that Walnut is kept.
  const server = (await ext.storage.local.get(PANEL_SERVER_KEY))[PANEL_SERVER_KEY]
  if (typeof server !== 'string' || !server) return
  const all = await readAll()
  if (view === 'ask') {
    const key = str(opts.key, 4100)
    const clean = cleanAsk(snap, now)
    if (!key || !clean) return
    // The agent the words are of: the message names it; an agent's key names it too.
    const agent = agentIdOf(opts.agentId) || (key.startsWith(ASK_AGENT_PREFIX) ? agentIdOf(key.slice(ASK_AGENT_PREFIX.length)) : '')
    // An agent's conversation under another agent's key is no one's.
    if (key.startsWith(ASK_AGENT_PREFIX) && (!agent || key !== agentAskKey(agent))) return
    const ask: Record<string, AskSnap> = { ...(all.ask ?? {}), [key]: clean }
    // A Walnut that keeps one conversation per agent: what an older view kept (per page, or one for
    // every agent) never draws again.
    if (key.startsWith(ASK_AGENT_PREFIX)) for (const k of Object.keys(ask)) if (k.startsWith('web:') || k === 'panel:current') delete ask[k]
    const kept = Object.entries(ask).sort((a, b) => b[1].at - a[1].at).slice(0, ASK_KEEP)
    all.ask = Object.fromEntries(kept)
    // Each agent's shell apart: one agent's Continue rows are its asks, never another's.
    if (agent && (clean.cont || clean.suggestions || clean.agent)) {
      const was = all.shells?.[agent]
      const shell: AskShell = { ...(was ?? {}), at: now, ...(clean.agent ? { agent: clean.agent } : {}), ...(clean.cont ? { cont: clean.cont } : {}), ...(clean.suggestions ? { suggestions: clean.suggestions, suggestionIcons: clean.suggestionIcons } : {}) }
      const shells = Object.entries({ ...(all.shells ?? {}), [agent]: shell }).sort((a, b) => b[1].at - a[1].at).slice(0, SHELLS_KEEP)
      all.shells = Object.fromEntries(shells)
    }
    delete (all as { shell?: unknown }).shell
  } else {
    const clean = cleanTasks(snap, opts.counts, now)
    if (!clean) return
    all.tasks = clean
  }
  await ext.storage.local.set({ [STORE]: all })
}

/** The agent the Ask view was last on, or '' when no view has said. */
export async function agentOf(): Promise<string> {
  return agentIdOf((await readAll()).agent?.id)
}

/** The name of the agent the Ask view was last on, as its header names it ('' for none). */
export async function agentNameOf(): Promise<string> {
  const a = (await readAll()).agent
  return agentIdOf(a?.id) ? str(a?.name, 60) : ''
}

/** The shell of last time (Continue list, suggestions, agent name) of `agent`, by default the agent the view was last on; null for none. */
export async function shellOf(now = Date.now(), agent?: string): Promise<AskShell | null> {
  const all = await readAll()
  const id = agent ?? agentIdOf(all.agent?.id)
  const s = id ? all.shells?.[id] : undefined
  return s && now - s.at < MAX_AGE_MS ? s : null
}

/**
 * What a view showed last time: Ask's open conversation of `agent` (by default the agent the view
 * was last on), whatever the page (`url` is no longer read); none with no agent known. Or the Tasks lists.
 */
export async function snapOf(view: SnapView, _url?: string, now = Date.now(), agent?: string): Promise<AskSnap | TasksSnap | null> {
  const all = await readAll()
  let s: AskSnap | TasksSnap | undefined
  if (view === 'ask') {
    const id = agent ?? agentIdOf(all.agent?.id)
    s = id ? all.ask?.[agentAskKey(id)] : undefined
  } else s = all.tasks
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

/**
 * The Tasks view before it has ever shown here (no lists of last time): its save row and the line
 * it says while its tasks load, in the view's places, never a blank body while Walnut's page starts
 * in its frame (about a second, longer on a busy machine; review 2026-11-06 round 4, R4-8: 2.5 s of
 * the bar alone).
 */
export function drawTasksLoading(): HTMLElement {
  return h('div', { class: 'panel-snap panel-snap-tasks', 'data-testid': 'panel-snap', 'data-snap': 'loading', 'aria-hidden': 'true' },
    h('div', { class: 'panel-snap-save' }, h('span', { class: 'panel-snap-btn' }, 'Save this page as a task')),
    h('p', { class: 'panel-snap-loading' }, h('span', { class: 'panel-snap-spinner' }), 'Loading your tasks…'))
}
