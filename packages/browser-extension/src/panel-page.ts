/**
 * What the side panel page does for Walnut's views it frames (the Ask view, the Tasks view):
 * names the page the person is on in this window (its address, title, selection, read from the tab
 * by the background), follows them to another tab or page, hands on a selection the context menu
 * asked about, lets an ask act in the tab when the person turns that on, and reads the page's text
 * when a question goes out with it. It hears only Walnut's frames, on the connected Walnut's origin.
 *
 * The panel's shells (panel-tabs.ts, panel-ask.ts) give it their frames and say what else they
 * hear; this part is the same in both.
 */
import { ask, ext } from './ext'

export const MSG = 'ext-panel'

export interface PagePlumbing {
  /** Tell every Walnut view that said it is ready. */
  post: (m: Record<string, unknown>) => void
  /** Tell the Ask view alone (once it is ready). */
  postAsk: (m: Record<string, unknown>) => void
  /** The page again, in a moment (the person moved on, a selection changed). */
  soon: () => void
}

type PageReply = { page: Record<string, unknown> | null; agents: boolean; owner?: string }
export type FrameMessage = { walnut?: string; type?: string; [k: string]: unknown }

export function startPagePlumbing(o: {
  server: string
  win: { id?: number }
  askFrame: HTMLIFrameElement
  /** Every Walnut view this page frames now. */
  frames: () => Array<HTMLIFrameElement | undefined>
  gone: () => boolean
  /** A web page is about to be named: the shell may draw the Ask view's words of last time over it. */
  onWebPage?: (url: string) => void
  /** A selection the context menu asked about: the Ask view is to show. */
  onAskSelection?: () => void
  /** A view said it is ready (after it was told the page). */
  onReady?: (w: Window) => void
  /** Everything else a view says (`shown`, `snapshot`, `theme`, the Ask view's own requests). */
  onMessage?: (d: FrameMessage, from: Window) => void
  /** The Ask view asked to close (Escape): the shell decides; with none, the page closes. */
  onClose?: () => void
}): PagePlumbing {
  const { server, win, askFrame: frame } = o
  const ready = new Set<Window>()
  const walnutFrame = (w: MessageEventSource | null): w is Window => !!w && o.frames().some((f) => !!f && f.contentWindow === w)
  const post = (m: Record<string, unknown>) => { for (const w of ready) w.postMessage({ walnut: MSG, ...m }, server) }
  const postAsk = (m: Record<string, unknown>) => { if (frame.contentWindow && ready.has(frame.contentWindow)) frame.contentWindow.postMessage({ walnut: MSG, ...m }, server) }

  let tabId: number | undefined
  let seq = 0
  /** The last page told, so a view that says it is ready hears it at once. */
  let told: Record<string, unknown> | null = null
  /** The tab and address the page itself answered for: until it has, its tab names it. */
  let named = ''
  const contextOf = (r: { ok: boolean } & Partial<PageReply>) => ({ type: 'context', page: r.ok ? r.page ?? null : null, ...(tabId !== undefined ? { tab: tabId } : {}), agents: !!(r.ok && r.agents), ...(r.ok && r.owner ? { owner: r.owner } : {}) })
  /** What waits for the next page told, by whichever push tells it (a later push may overtake one). */
  const afterTell: Array<() => void> = []
  const tell = (m: Record<string, unknown>) => {
    told = m
    post(m)
    for (const f of afterTell.splice(0)) f()
  }
  /**
   * Name the page to every ready view: the tab at once, the page's own answer after it.
   * `onTold` runs once, right after the next page told, by this push or a later one (review R3-7: a view that said it
   * is ready waited for the page's own answer, a round trip into the tab, before it heard anything
   * else, its vault state and a question the popup handed over included).
   */
  const push = async (onTold?: () => void) => {
    if (o.gone()) return
    if (onTold) afterTell.push(onTold)
    const mine = ++seq
    const [tab] = await ext.tabs.query({ active: true, windowId: win.id })
    tabId = tab?.id
    const at = `${tabId}:${tab?.url ?? ''}`
    if (tab?.url && /^https?:/.test(tab.url) && !tab.url.startsWith(`${server}/`)) o.onWebPage?.(tab.url)
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

  /**
   * The browser relay for the Ask view's first page (its pill and panel, ExtRelay.tsx): the agents
   * switch and the tabs agents hold, told when the view is ready and whenever either changes.
   */
  let relayTold = ''
  const tellRelay = async () => {
    if (o.gone() || !frame.contentWindow || !ready.has(frame.contentWindow)) return
    const r = await ask<{ on: boolean; tabs: unknown[] }>({ type: 'relay-state' })
    if (!r.ok) return
    const m = { type: 'relay', on: r.on === true, tabs: Array.isArray(r.tabs) ? r.tabs : [] }
    const words = JSON.stringify(m)
    if (words === relayTold) return
    relayTold = words
    postAsk(m)
  }
  let relayTimer: ReturnType<typeof setTimeout> | undefined
  const relaySoon = () => { clearTimeout(relayTimer); relayTimer = setTimeout(() => void tellRelay(), 150) }

  /** A selection the context menu asked about while the Ask view was not up yet: it goes once that view is. */
  let heldSelection = ''
  const pending = async () => {
    const r = await ask<{ text?: string }>({ type: 'panel-pending', windowId: win.id })
    if (!r.ok || !r.text) return
    o.onAskSelection?.()
    if (frame.contentWindow && ready.has(frame.contentWindow)) postAsk({ type: 'ask-selection', text: r.text })
    else heldSelection = r.text
    soon()
  }

  window.addEventListener('message', (e) => {
    if (o.gone() || !walnutFrame(e.source) || e.origin !== server) return
    const d = e.data as FrameMessage | null
    if (!d || d.walnut !== MSG) return
    const from = e.source
    if (d.type === 'ready') {
      ready.add(from)
      if (told) from.postMessage({ walnut: MSG, ...told }, server)
      // The page first (it picks the conversation), then a selection held for the Ask view.
      void push(() => {
        if (from === frame.contentWindow && heldSelection) { postAsk({ type: 'ask-selection', text: heldSelection }); heldSelection = '' }
        if (from === frame.contentWindow) { relayTold = ''; void tellRelay() }
        o.onReady?.(from)
      }).then(pending)
      return
    }
    if (d.type === 'refresh') { soon(); return }
    // `vault-changed`: Walnut announced a change of who holds an unlock (its `vault:changed`), heard by any of its views.
    // `agent`: the agent the Ask view is on (its words are kept per agent, panel-snap.ts).
    if (d.type === 'shown' || d.type === 'snapshot' || d.type === 'agent' || d.type === 'theme' || d.type === 'vault-changed') { o.onMessage?.(d, from); return }
    // Acting in the tab, the page's text and closing are the Ask view's alone.
    if (from !== frame.contentWindow) return
    switch (d.type) {
      case 'close': if (o.onClose) o.onClose(); else window.close(); return
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
      // The relay panel: the agents switch, a tab's Stop or Unshare (any agent tab), Stop all.
      case 'relay-set':
        if (typeof d.on !== 'boolean') return
        void ask({ type: d.on ? 'agent-on' : 'agent-off' }).then(() => { void tellRelay(); void push() })
        return
      case 'relay-release':
        if (typeof d.tab !== 'number') return
        void ask({ type: 'panel-release', tabId: d.tab }).then(() => { void tellRelay(); void push() })
        return
      case 'relay-stop-all':
        void ask({ type: 'relay-stop-all' }).then(() => { void tellRelay(); void push() })
        return
      case 'browser-key-ask': {
        // The frame shares the extension's unlock: the key it should keep, from the background
        // (hand-browser-key.ts handPanelBrowserKey), told to this frame only, at Walnut's origin.
        const had = typeof d.key === 'string' && /^[A-Za-z0-9_-]{43}$/.test(d.key) ? d.key : undefined
        void ask<{ key?: string; known?: boolean }>({ type: 'panel-browser-key', ...(had ? { key: had } : {}) }).then((r) => {
          postAsk({ type: 'browser-key', ...(r.ok && typeof r.key === 'string' ? { key: r.key } : {}), ok: r.ok })
        })
        return
      }
      case 'page-text': {
        // A question goes out with the page: its text, read now, from the tab the panel named.
        if (typeof d.id !== 'string') return
        const id = d.id
        void ask<{ page: { url?: string; text?: string } | null }>({ type: 'panel-page', tabId, withText: true }).then((r) => {
          postAsk({ type: 'page-text', id, url: r.ok ? r.page?.url ?? '' : '', text: r.ok ? r.page?.text ?? '' : '' })
        })
        return
      }
      default: o.onMessage?.(d, from)
    }
  })

  ext.tabs.onActivated.addListener((info) => { if (info.windowId === win.id) soon() })
  ext.tabs.onUpdated.addListener((id, change) => {
    if (id === tabId && (change.status === 'complete' || change.url || change.title)) soon()
    // An agent tab's page moved on: its row in the relay panel names the new page.
    if (change.url || change.title) relaySoon()
  })
  ext.tabs.onRemoved.addListener(() => relaySoon())
  ext.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && 'agentControl' in changes) relaySoon()
    if (area !== 'session') return
    if ('panelAsk' in changes && changes.panelAsk.newValue) void pending()
    // Stop on the page, or another task's tab: the panel's switch follows.
    if ('agentTabs' in changes) { soon(); relaySoon() }
  })
  // A selection made on the page this panel follows.
  ext.runtime.onMessage.addListener((m: { type?: string; tabId?: number }) => {
    if (m?.type === 'panel-selection' && m.tabId === tabId) soon()
  })
  // The person comes back to the panel to type: the selection they made meanwhile is current.
  window.addEventListener('focus', soon)
  // Asked now, while the views load: each hears it the moment it is ready.
  void push()
  return { post, postAsk, soon }
}
