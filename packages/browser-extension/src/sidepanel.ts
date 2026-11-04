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
 */
import { ask, ext } from './ext'
import { h } from './dom'

const root = document.getElementById('root')!
const MSG = 'ext-panel'

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
  root.replaceChildren(frame)

  let ready = false
  const post = (m: Record<string, unknown>) => { if (ready) frame.contentWindow?.postMessage({ walnut: MSG, ...m }, server) }

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

  const pending = async () => {
    const r = await ask<{ text?: string }>({ type: 'panel-pending', windowId: win.id })
    if (r.ok && r.text) { post({ type: 'ask-selection', text: r.text }); soon() }
  }

  window.addEventListener('message', (e) => {
    if (e.source !== frame.contentWindow || e.origin !== server) return
    const d = e.data as { walnut?: string; type?: string; tab?: unknown; task?: unknown; who?: unknown; id?: unknown } | null
    if (!d || d.walnut !== MSG) return
    switch (d.type) {
      case 'ready':
        ready = true
        void push().then(pending)
        return
      case 'refresh': soon(); return
      case 'close': window.close(); return
      case 'adopt':
        // Only the tab this panel named, for the ask the panel shows.
        if (typeof d.tab !== 'number' || d.tab !== tabId || typeof d.task !== 'string') return
        void ask({ type: 'panel-adopt', tabId: d.tab, task: d.task, who: typeof d.who === 'string' ? d.who : undefined }).then((r) => {
          post({ type: 'adopted', ok: r.ok, ...(r.ok ? {} : { error: r.error ?? 'Walnut could not take this tab.' }) })
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
          post({ type: 'page-text', id, url: r.ok ? r.page?.url ?? '' : '', text: r.ok ? r.page?.text ?? '' : '' })
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
