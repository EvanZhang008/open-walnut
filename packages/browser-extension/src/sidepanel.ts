/**
 * The browser's side panel (Chrome's side panel, Firefox's sidebar): Walnut's own page framed
 * here (`/popout?view=ext-panel`, web/src/popout/PopoutExtPanel.tsx), told by postMessage about
 * the page the person is on in this window. It hears only from that frame, on the connected
 * Walnut's origin, and tells only it.
 *
 * What this page does for the frame: names the page (its address, title, selection and text,
 * read from the tab by the background), follows the person to another tab or page, hands on a
 * selection the context menu asked about, and lets an ask act in the tab when the person turns
 * that on in the panel.
 *
 * Three tabs, the one picked kept for the next time (storage.local `panelTab`): Ask (that view),
 * Tasks (`/popout?view=ext-tasks`: what needs the person, their Focus tasks, the page saved as a
 * task; it hears the same page messages) and Passwords (this extension's own vault view,
 * popup.html in its panel form, for the logins of the page in this window). Each tab's frame is
 * made the first time it is shown and then kept, so a tab keeps its state.
 */
import { ask, ext } from './ext'
import { h } from './dom'
import { drawSnap, keepSnap, snapOf, type SnapView } from './panel-snap'
import { PANEL_SERVER_KEY, clearPanelData } from './panel-data'

const root = document.getElementById('root')!
const MSG = 'ext-panel'

type PanelTab = 'ask' | 'tasks' | 'passwords'
const PANEL_TABS: ReadonlyArray<[PanelTab, string]> = [['ask', 'Ask'], ['tasks', 'Tasks'], ['passwords', 'Passwords']]

function message(title: string, body: string, action?: { label: string; run: () => void }): void {
  root.replaceChildren(h('div', { class: 'center' },
    h('h2', {}, title),
    h('p', {}, body),
    action ? h('button', { class: 'btn btn-primary', type: 'button', onclick: action.run }, action.label) : null))
}

/** The Walnut the panel showed last time: its frames start loading before the background answers. */
const KEPT_SERVER = PANEL_SERVER_KEY

const CONNECT = ['Connect to Walnut', 'Open the Walnut button in the toolbar and connect this browser to your Walnut, then open this panel again.'] as const

/**
 * No Walnut to show any more (disconnected, or one too old): every Walnut frame goes at once, so
 * none can still ask this panel for a page or its text, and nothing more is said to one.
 */
let gone = false
function closeFrames(): void {
  gone = true
  for (const f of Array.from(document.querySelectorAll('iframe'))) { f.src = 'about:blank'; f.remove() }
}

type PanelState = { ok: boolean; connected?: boolean; serverUrl?: string; panel?: boolean }

/** The connected Walnut's origin, or null with the panel saying why there is none. */
function serverOf(st: PanelState): string | null {
  if (!st.ok || !st.connected || !st.serverUrl) {
    message(...CONNECT)
    return null
  }
  if (st.panel === false) {
    message('Update Walnut', 'The Walnut this browser is connected to is older than this extension and has no side panel yet. Update Walnut, then open this panel again.')
    return null
  }
  return new URL(st.serverUrl).origin
}

async function start(): Promise<void> {
  // The background checks the connection with a round trip to Walnut; the Walnut of last time
  // starts loading meanwhile, and the answer replaces it only when it says otherwise.
  const kept = (await ext.storage.local.get(KEPT_SERVER))[KEPT_SERVER]
  const state = ask<PanelState>({ type: 'panel-state' })
  let server: string
  if (typeof kept === 'string' && kept) {
    server = kept
    void state.then((st) => {
      if (!st.ok) return // the background did not answer: the frame of last time stays
      const now = serverOf(st)
      if (now === kept) return
      if (now) { void ext.storage.local.set({ [KEPT_SERVER]: now }).then(() => location.reload()); return }
      // No Walnut now: the frame of last time goes, and with no connection what it showed too.
      closeFrames()
      if (!st.connected) void clearPanelData()
      else void ext.storage.local.set({ [KEPT_SERVER]: '' })
    })
  } else {
    const now = serverOf(await state)
    if (!now) return
    server = now
    void ext.storage.local.set({ [KEPT_SERVER]: now })
  }
  // Opened as a window of its own (a browser with no side panel), it follows the window it was opened for.
  const forWindow = Number(new URLSearchParams(location.search).get('window'))
  const win = Number.isInteger(forWindow) && forWindow > 0 ? { id: forWindow } : await ext.windows.getCurrent()
  if (gone) return
  const frame = h('iframe', {
    class: 'panel-frame',
    src: `${server}/popout?view=ext-panel`,
    title: 'Walnut',
    allow: 'clipboard-write; microphone',
  }) as HTMLIFrameElement
  const frames: Record<PanelTab, () => HTMLIFrameElement> = {
    ask: () => frame,
    tasks: () => h('iframe', { class: 'panel-frame-tasks', src: `${server}/popout?view=ext-tasks`, title: 'Walnut tasks' }) as HTMLIFrameElement,
    passwords: () => h('iframe', { class: 'panel-frame-passwords', src: ext.runtime.getURL(`popup.html?embed=panel&window=${win.id ?? ''}`), title: 'Walnut passwords', allow: 'clipboard-write' }) as HTMLIFrameElement,
  }
  const made = new Map<PanelTab, HTMLIFrameElement>()
  const body = h('div', { class: 'panel-body' })
  const buttons = new Map<PanelTab, HTMLButtonElement>()
  /** Ask's and Tasks' drawing of last time (panel-snap.ts), until the view says its own is up. */
  const covers = new Map<SnapView, HTMLElement>()
  const upViews = new Set<SnapView>()
  let current: PanelTab = 'ask'
  const uncover = (view: SnapView) => { upViews.add(view); covers.get(view)?.remove(); covers.delete(view) }
  const cover = async (view: SnapView, url?: string) => {
    if (upViews.has(view) || covers.has(view)) return
    const snap = await snapOf(view, url)
    if (!snap || upViews.has(view) || covers.has(view)) return
    const el = drawSnap(view, snap)
    el.hidden = current !== view
    covers.set(view, el)
    body.append(el)
    // A view that never says so (an old Walnut) still gets its frame back.
    setTimeout(() => uncover(view), 15_000)
  }
  const show = (tab: PanelTab) => {
    current = tab
    if (!made.has(tab)) { const f = frames[tab](); made.set(tab, f); body.append(f) }
    for (const [t, f] of made) f.hidden = t !== tab
    for (const [v, el] of covers) el.hidden = v !== tab
    if (tab === 'tasks') void cover('tasks')
    for (const [t, b] of buttons) { b.setAttribute('aria-selected', String(t === tab)); b.tabIndex = t === tab ? 0 : -1 }
    void ext.storage.local.set({ panelTab: tab })
  }
  const bar = h('div', { class: 'panel-tabs', role: 'tablist', 'aria-label': 'Walnut' },
    ...PANEL_TABS.map(([id, label]) => {
      const b = h('button', { class: 'panel-tab', type: 'button', role: 'tab', 'data-testid': `panel-tab-${id}`, onclick: () => show(id) }, label) as HTMLButtonElement
      buttons.set(id, b)
      return b
    }))
  const keptTab = (await ext.storage.local.get('panelTab')).panelTab
  if (gone) return
  root.replaceChildren(h('div', { class: 'panel-shell' }, bar, body))
  show(PANEL_TABS.some(([id]) => id === keptTab) ? keptTab as PanelTab : 'ask')

  /** The Walnut views (Ask, Tasks) that said they are ready: each is told about the page. */
  const ready = new Set<Window>()
  const walnutFrame = (w: MessageEventSource | null): w is Window => !!w && [made.get('ask'), made.get('tasks')].some((f) => f?.contentWindow === w)
  const post = (m: Record<string, unknown>) => { for (const w of ready) w.postMessage({ walnut: MSG, ...m }, server) }
  /** What only the Ask view hears: a selection to ask about, a hand-over's answer, the page's text. */
  const postAsk = (m: Record<string, unknown>) => { if (frame.contentWindow && ready.has(frame.contentWindow)) frame.contentWindow.postMessage({ walnut: MSG, ...m }, server) }

  let tabId: number | undefined
  let seq = 0
  /** The last page told, so a view that says it is ready hears it at once. */
  let told: Record<string, unknown> | null = null
  /** The tab and address the page itself answered for: until it has, its tab names it. */
  let named = ''
  type PageReply = { page: Record<string, unknown> | null; agents: boolean; owner?: string }
  const contextOf = (r: { ok: boolean } & Partial<PageReply>) => ({ type: 'context', page: r.ok ? r.page ?? null : null, ...(tabId !== undefined ? { tab: tabId } : {}), agents: !!(r.ok && r.agents), ...(r.ok && r.owner ? { owner: r.owner } : {}) })
  const tell = (m: Record<string, unknown>) => { told = m; post(m) }
  const push = async () => {
    if (gone) return
    const mine = ++seq
    const [tab] = await ext.tabs.query({ active: true, windowId: win.id })
    tabId = tab?.id
    const at = `${tabId}:${tab?.url ?? ''}`
    if (tab?.url && /^https?:/.test(tab.url) && !tab.url.startsWith(`${server}/`)) void cover('ask', tab.url)
    // A tab or address not answered for yet is named by the tab at once, the page's own answer
    // (its selection) after it: a page that answers late never holds the panel on "Connecting".
    const full = ask<PageReply>({ type: 'panel-page', tabId })
    if (at !== named) {
      const quick = await ask<PageReply>({ type: 'panel-page', tabId, quick: true })
      if (mine !== seq) return
      if (quick.ok) tell(contextOf(quick))
    }
    const r = await full
    if (mine !== seq) return
    named = at
    tell(contextOf(r))
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const soon = () => { clearTimeout(timer); timer = setTimeout(() => void push(), 250) }

  /** A selection the context menu asked about while the Ask view was not up yet: it goes once that view is. */
  let heldSelection = ''
  const pending = async () => {
    const r = await ask<{ text?: string }>({ type: 'panel-pending', windowId: win.id })
    if (!r.ok || !r.text) return
    show('ask')
    if (frame.contentWindow && ready.has(frame.contentWindow)) postAsk({ type: 'ask-selection', text: r.text })
    else heldSelection = r.text
    soon()
  }

  window.addEventListener('message', (e) => {
    if (gone || !walnutFrame(e.source) || e.origin !== server) return
    const d = e.data as { walnut?: string; type?: string; tab?: unknown; task?: unknown; who?: unknown; id?: unknown } | null
    if (!d || d.walnut !== MSG) return
    if (d.type === 'ready') {
      ready.add(e.source)
      if (told) e.source.postMessage({ walnut: MSG, ...told }, server)
      // The page first (it picks the conversation), then a selection held for the Ask view.
      void push().then(() => {
        if (e.source === frame.contentWindow && heldSelection) { postAsk({ type: 'ask-selection', text: heldSelection }); heldSelection = '' }
      }).then(pending)
      return
    }
    if (d.type === 'refresh') { soon(); return }
    if (d.type === 'shown' || d.type === 'snapshot') {
      const view: SnapView = e.source === frame.contentWindow ? 'ask' : 'tasks'
      if (d.type === 'shown') uncover(view)
      else {
        const m = d as { view?: unknown; key?: unknown; snap?: unknown; counts?: unknown }
        if (m.view === view) void keepSnap(view, m.snap, { key: m.key, counts: m.counts })
      }
      return
    }
    // Acting in the tab, the page's text and closing are the Ask view's alone.
    if (e.source !== frame.contentWindow) return
    switch (d.type) {
      case 'close': window.close(); return
      case 'adopt':
        // Only the tab this panel named, for the ask the panel shows.
        if (typeof d.tab !== 'number' || d.tab !== tabId || typeof d.task !== 'string') return
        void ask({ type: 'panel-adopt', tabId: d.tab, task: d.task, who: typeof d.who === 'string' ? d.who : undefined }).then((r) => {
          postAsk({ type: 'adopted', ok: r.ok, ...(r.ok ? {} : { error: r.error ?? 'Walnut could not take this tab.' }) })
          void push()
        })
        return
      case 'release':
        if (typeof d.tab !== 'number' || d.tab !== tabId) return
        void ask({ type: 'panel-release', tabId: d.tab }).then(() => void push())
        return
      case 'page-text': {
        // A question goes out with the page: its text, read now, from the tab the panel named.
        if (typeof d.id !== 'string') return
        const id = d.id
        void ask<{ page: { url?: string; text?: string } | null }>({ type: 'panel-page', tabId, withText: true }).then((r) => {
          postAsk({ type: 'page-text', id, url: r.ok ? r.page?.url ?? '' : '', text: r.ok ? r.page?.text ?? '' : '' })
        })
      }
    }
  })

  ext.tabs.onActivated.addListener((info) => { if (info.windowId === win.id) soon() })
  ext.tabs.onUpdated.addListener((id, change) => {
    if (id === tabId && (change.status === 'complete' || change.url || change.title)) soon()
  })
  ext.storage.onChanged.addListener((changes, area) => {
    // Disconnected while open (panel-data.ts removes the server): the Walnut frames go now.
    if (area === 'local' && KEPT_SERVER in changes && !changes[KEPT_SERVER].newValue && !gone) {
      closeFrames()
      message(...CONNECT)
      return
    }
    if (area !== 'session') return
    if ('panelAsk' in changes && changes.panelAsk.newValue) void pending()
    // Stop on the page, or another task's tab: the panel's switch follows.
    if ('agentTabs' in changes) soon()
  })
  // A selection made on the page this panel follows.
  ext.runtime.onMessage.addListener((m: { type?: string; tabId?: number }) => {
    if (m?.type === 'panel-selection' && m.tabId === tabId) soon()
  })
  // The person comes back to the panel to type: the selection they made meanwhile is current.
  window.addEventListener('focus', soon)
  // Asked now, while the views load: each hears it the moment it is ready.
  void push()
}

void start()
