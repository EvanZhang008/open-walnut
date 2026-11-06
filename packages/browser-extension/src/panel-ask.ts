/**
 * The side panel, and the toolbar popup, as Walnut's own Ask (a Walnut whose panel answer says
 * `askPanel`): one frame, `/popout?view=ext-panel&ext=2` (`&surface=popup` in the popup), whose
 * header has the ≡ drawer of asks and a key button. This page draws what Walnut's page must not:
 * the key popover over the frame (key-pop.ts), and the full Tasks and Passwords views with a Back
 * control, which the drawer's foot opens.
 *
 * It tells the frame how the vault stands (`vault-state`: locked, this site's count) whenever that
 * changes, following it as the popup does (an unlock in a Walnut window, a Lock all elsewhere).
 * The popup closes when focus leaves it, so its question goes to the side panel: it opens the panel
 * (still inside the person's click, which the frame's click activates this page for) and leaves
 * the question in storage.session for the panel of its window (`panelHand`), which hands it to its
 * Ask view.
 */
import { ask, ext } from './ext'
import { h } from './dom'
import { popupIcon } from './popup-ui'
import { drawSnap, keepSnap, snapOf, type SnapView } from './panel-snap'
import { startPagePlumbing } from './panel-page'
import { keyPopover } from './key-pop'

type FullView = 'tasks' | 'passwords'
/** The popup's hand-over waits this long for its panel; an older one is not the person's now. */
const HAND_MS = 60_000

export async function startAsk(root: HTMLElement, server: string, win: { id?: number }, surface: 'panel' | 'popup', inTab: boolean, gone: () => boolean): Promise<void> {
  const frame = h('iframe', {
    class: 'panel-frame',
    src: `${server}/popout?view=ext-panel&ext=2${surface === 'popup' ? '&surface=popup' : ''}`,
    title: 'Walnut',
    allow: 'clipboard-write; microphone',
  }) as HTMLIFrameElement
  const body = h('div', { class: 'panel-body' }, frame)
  root.replaceChildren(h('div', { class: `panel-shell is-ask is-${surface}` }, body))

  // ── the full views the drawer's foot opens, over the Ask frame, each kept once made ──
  const views = new Map<FullView, { el: HTMLElement; frame: HTMLIFrameElement }>()
  let current: FullView | null = null
  const showView = (v: FullView | null) => {
    current = v
    if (v && !views.has(v)) {
      const f = v === 'tasks'
        ? h('iframe', { class: 'panel-frame-tasks', src: `${server}/popout?view=ext-tasks`, title: 'Walnut tasks' }) as HTMLIFrameElement
        : h('iframe', { class: 'panel-frame-passwords', src: ext.runtime.getURL(`popup.html?embed=panel&view=1&window=${win.id ?? ''}`), title: 'Walnut passwords', allow: 'clipboard-write' }) as HTMLIFrameElement
      // Passwords draws its own bar (Back, the title and its tools in one row: popup.ts `inView`).
      const el = h('div', { class: 'panel-view', 'data-testid': `panel-view-${v}` },
        v === 'tasks' ? h('div', { class: 'panel-view-bar' },
          h('button', { class: 'back-btn', type: 'button', 'data-testid': 'panel-view-back', onclick: () => showView(null) }, popupIcon('back'), h('span', {}, 'Ask')),
          h('span', { class: 'panel-view-title' }, 'Tasks')) : null,
        f)
      views.set(v, { el, frame: f })
      body.append(el)
      if (v === 'tasks') void cover('tasks')
    }
    for (const [k, x] of views) x.el.hidden = k !== v
    for (const [k, c] of covers) c.hidden = k === 'tasks' ? v !== 'tasks' : v !== null
    key.close()
    if (!v) frame.focus()
  }

  // The Passwords view's own Back (popup.ts viewBack), from that frame on this extension's origin.
  window.addEventListener('message', (e) => {
    const d = e.data as { walnut?: unknown; type?: unknown } | null
    if (e.origin !== location.origin || d?.walnut !== 'panel-view' || d.type !== 'back') return
    if (e.source && e.source === views.get('passwords')?.frame.contentWindow) showView(null)
  })

  // ── what Ask and Tasks showed last time, until each view says its own is up (panel-snap.ts) ──
  const covers = new Map<SnapView, HTMLElement>()
  const upViews = new Set<SnapView>()
  const uncover = (view: SnapView) => { upViews.add(view); covers.get(view)?.remove(); covers.delete(view) }
  const cover = async (view: SnapView, url?: string) => {
    if (surface === 'popup' || upViews.has(view) || covers.has(view)) return
    const snap = await snapOf(view, url)
    if (!snap || upViews.has(view) || covers.has(view)) return
    const el = drawSnap(view, snap, 'ask')
    covers.set(view, el)
    if (view === 'tasks') views.get('tasks')?.el.append(el)
    else { el.hidden = current !== null; body.append(el) }
    // A view that never says so still gets its frame back.
    setTimeout(() => uncover(view), 15_000)
  }

  // ── the key popover and the vault it shows ──
  let told = ''
  let locked = true
  const tellVault = async () => {
    if (gone()) return
    const st = await ask<{ connected: boolean; unlocked: boolean }>({ type: 'vault-watch' })
    if (!st.ok) return
    const nowLocked = !st.unlocked
    const [tab] = await ext.tabs.query({ active: true, windowId: win.id })
    let host = ''
    try { host = tab?.url && /^https?:/.test(tab.url) ? new URL(tab.url).host : '' } catch { /* no page */ }
    const count = nowLocked ? { ok: true, count: null } : await ask<{ count: number | null }>({ type: 'site-count', windowId: win.id })
    const m = { type: 'vault-state', locked: nowLocked, siteCount: count.ok ? count.count : null, host }
    const flipped = nowLocked !== locked
    locked = nowLocked
    if (flipped) key.refresh()
    const s = JSON.stringify(m)
    if (s === told) return
    told = s
    page.postAsk(m)
  }
  const key = keyPopover({
    host: body,
    windowId: win.id,
    surface,
    inTab,
    onSearchAll: () => { if (surface === 'panel') showView('passwords'); else location.href = 'popup.html?from=ask' },
    onOpenVault: () => { void ask({ type: 'open-walnut' }).then(() => { if (surface === 'popup' && !inTab) window.close() }) },
    onChange: (open) => page.postAsk({ type: 'key-state', open }),
    onVault: () => void tellVault(),
    onEscape: () => frame.focus(),
  })

  /** The popup's question for this window's panel: a new ask, or an ask to show. */
  const takeHand = async () => {
    if (surface !== 'panel') return
    const { panelHand } = await ext.storage.session.get('panelHand')
    const hand = panelHand as { windowId?: number; at?: number; ask?: unknown; open?: unknown; view?: unknown } | undefined
    if (!hand || hand.windowId !== win.id || Date.now() - (hand.at ?? 0) > HAND_MS) return
    await ext.storage.session.remove('panelHand')
    if (hand.view === 'tasks') { showView('tasks'); return }
    showView(null)
    page.postAsk({ type: 'hand', ...(hand.ask ? { ask: hand.ask } : {}), ...(hand.open ? { open: hand.open } : {}) })
  }

  /** The popup: the side panel of this window opens with what the person picked or asked. */
  const toSidePanel = (hand: Record<string, unknown>) => {
    // Inside the person's click (the frame's click activates the pages above it): the side panel
    // opens only with it, so nothing is awaited before.
    let opened: Promise<unknown> = Promise.reject(new Error('no side panel'))
    if (!inTab && ext.sidePanel && win.id !== undefined) opened = ext.sidePanel.open({ windowId: win.id })
    else if (!inTab && ext.sidebarAction) opened = ext.sidebarAction.open()
    const kept = ext.storage.session.set({ panelHand: { windowId: win.id, ...hand, at: Date.now() } })
    void Promise.allSettled([opened, kept]).then(async ([o]) => {
      // No side panel here (or a test's tab): the same page in a window of its own, beside this one.
      if (o.status === 'rejected' && win.id !== undefined) await ext.windows.create({ url: ext.runtime.getURL(`sidepanel.html?window=${win.id}`), type: 'popup', width: 420, height: 760 })
      if (!inTab) window.close()
    })
  }

  const page = startPagePlumbing({
    server, win, askFrame: frame, gone,
    frames: () => [frame, views.get('tasks')?.frame],
    onWebPage: (url) => void cover('ask', url),
    onAskSelection: () => showView(null),
    onReady: (w) => {
      if (w !== frame.contentWindow) return
      told = ''
      void tellVault()
      void takeHand()
    },
    onMessage: (d, from) => {
      if (d.type === 'shown' || d.type === 'snapshot') {
        const view: SnapView = from === frame.contentWindow ? 'ask' : 'tasks'
        if (d.type === 'shown') uncover(view)
        else if (d.view === view) void keepSnap(view, d.snap, { key: d.key, counts: d.counts })
        return
      }
      switch (d.type) {
        case 'key-toggle': {
          const r = d.rect as { top?: unknown; right?: unknown; bottom?: unknown; left?: unknown } | undefined
          const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
          // The frame's own coordinates, moved by where the frame sits on this page.
          const at = frame.getBoundingClientRect()
          const b = body.getBoundingClientRect()
          const dx = at.left - b.left
          const dy = at.top - b.top
          key.toggle({ top: n(r?.top) + dy, right: n(r?.right) + dx, bottom: n(r?.bottom) + dy, left: n(r?.left) + dx })
          return
        }
        case 'key-close': case 'frame-pointer': key.close(); return
        case 'open-view':
          if (d.view === 'passwords' && surface === 'popup') { location.href = 'popup.html?from=ask'; return }
          if (d.view === 'tasks' || d.view === 'passwords') showView(d.view)
          return
        case 'open-walnut':
          void ask({ type: 'open-walnut', ...(typeof d.path === 'string' ? { path: d.path } : {}) }).then(() => { if (surface === 'popup' && !inTab) window.close() })
          return
        case 'open-side-panel':
          if (surface !== 'popup') return
          toSidePanel({
            ...(d.ask && typeof d.ask === 'object' ? { ask: d.ask } : {}),
            ...(d.open && typeof d.open === 'object' ? { open: d.open } : {}),
            ...(d.view === 'tasks' ? { view: 'tasks' } : {}),
          })
      }
    },
  })

  // The vault as Walnut sees it now (popup.ts followVault): a Lock all elsewhere locks the key here
  // within seconds, an unlock in a Walnut window unlocks it.
  setInterval(() => { if (document.visibilityState === 'visible') void tellVault() }, 3000)
  document.addEventListener('visibilitychange', () => void tellVault())
  let soon: ReturnType<typeof setTimeout> | undefined
  const later = () => { clearTimeout(soon); soon = setTimeout(() => { told = ''; void tellVault(); if (key.isOpen()) key.refresh() }, 300) }
  ext.tabs.onActivated.addListener((info) => { if (info.windowId === win.id) later() })
  ext.tabs.onUpdated.addListener((_id, change, tab) => { if (tab.windowId === win.id && tab.active && (change.url || change.status === 'complete')) later() })
  ext.storage.onChanged.addListener((changes, area) => {
    if (area !== 'session') return
    if ('vaultSession' in changes) void tellVault()
    if ('panelHand' in changes && changes.panelHand.newValue) void takeHand()
  })
}
