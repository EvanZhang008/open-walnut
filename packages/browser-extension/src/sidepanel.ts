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

async function start(): Promise<void> {
  const st = await ask<{ connected: boolean; serverUrl?: string; panel?: boolean }>({ type: 'panel-state' })
  if (!st.ok || !st.connected || !st.serverUrl) {
    message('Connect to Walnut', 'Open the Walnut button in the toolbar and connect this browser to your Walnut, then open this panel again.')
    return
  }
  if (st.panel === false) {
    message('Update Walnut', 'The Walnut this browser is connected to is older than this extension and has no side panel yet. Update Walnut, then open this panel again.')
    return
  }
  const server = new URL(st.serverUrl).origin
  // Opened as a window of its own (a browser with no side panel), it follows the window it was opened for.
  const forWindow = Number(new URLSearchParams(location.search).get('window'))
  const win = Number.isInteger(forWindow) && forWindow > 0 ? { id: forWindow } : await ext.windows.getCurrent()
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
  const show = (tab: PanelTab) => {
    if (!made.has(tab)) { const f = frames[tab](); made.set(tab, f); body.append(f) }
    for (const [t, f] of made) f.hidden = t !== tab
    for (const [t, b] of buttons) { b.setAttribute('aria-selected', String(t === tab)); b.tabIndex = t === tab ? 0 : -1 }
    void ext.storage.local.set({ panelTab: tab })
  }
  const bar = h('div', { class: 'panel-tabs', role: 'tablist', 'aria-label': 'Walnut' },
    ...PANEL_TABS.map(([id, label]) => {
      const b = h('button', { class: 'panel-tab', type: 'button', role: 'tab', 'data-testid': `panel-tab-${id}`, onclick: () => show(id) }, label) as HTMLButtonElement
      buttons.set(id, b)
      return b
    }))
  root.replaceChildren(h('div', { class: 'panel-shell' }, bar, body))
  const kept = (await ext.storage.local.get('panelTab')).panelTab
  show(PANEL_TABS.some(([id]) => id === kept) ? kept as PanelTab : 'ask')

  /** The Walnut views (Ask, Tasks) that said they are ready: each is told about the page. */
  const ready = new Set<Window>()
  const walnutFrame = (w: MessageEventSource | null): w is Window => !!w && [made.get('ask'), made.get('tasks')].some((f) => f?.contentWindow === w)
  const post = (m: Record<string, unknown>) => { for (const w of ready) w.postMessage({ walnut: MSG, ...m }, server) }
  /** What only the Ask view hears: a selection to ask about, a hand-over's answer, the page's text. */
  const postAsk = (m: Record<string, unknown>) => { if (frame.contentWindow && ready.has(frame.contentWindow)) frame.contentWindow.postMessage({ walnut: MSG, ...m }, server) }

  let tabId: number | undefined
  let seq = 0
  const push = async () => {
    const mine = ++seq
    const [tab] = await ext.tabs.query({ active: true, windowId: win.id })
    tabId = tab?.id
    const r = await ask<{ page: Record<string, unknown> | null; agents: boolean; owner?: string }>({ type: 'panel-page', tabId })
    if (mine !== seq) return
    post({ type: 'context', page: r.ok ? r.page : null, ...(tabId !== undefined ? { tab: tabId } : {}), agents: r.ok && r.agents, ...(r.ok && r.owner ? { owner: r.owner } : {}) })
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
    if (!walnutFrame(e.source) || e.origin !== server) return
    const d = e.data as { walnut?: string; type?: string; tab?: unknown; task?: unknown; who?: unknown; id?: unknown } | null
    if (!d || d.walnut !== MSG) return
    if (d.type === 'ready') {
      ready.add(e.source)
      if (e.source === frame.contentWindow && heldSelection) { postAsk({ type: 'ask-selection', text: heldSelection }); heldSelection = '' }
      void push().then(pending)
      return
    }
    if (d.type === 'refresh') { soon(); return }
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
}

void start()
