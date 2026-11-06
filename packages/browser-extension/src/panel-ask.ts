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
 * the question in storage.session for the panel of its window (`panelHand`), which the background
 * hands to one panel only (`panel-hand`), and that panel to its Ask view.
 *
 * Until the frame says its view is up, this page draws the same Ask itself (panel-look.ts), and it
 * takes Walnut's theme from the frame (panel-theme.ts) for the popover and the views it draws.
 */
import { ask, ext } from './ext'
import { h } from './dom'
import { popupIcon } from './popup-ui'
import { drawSnap, keepSnap, shellOf, snapOf, type AskSnap, type SnapView } from './panel-snap'
import { drawAskLook, type AskLook } from './panel-look'
import { startPagePlumbing } from './panel-page'
import { keyPopover } from './key-pop'
import { keepTheme } from './panel-theme'

type FullView = 'tasks' | 'passwords' | 'settings'
/** The vault state this page last told its frame (storage.session: gone with the browser), for the next open's first word. */
const KEPT_VAULT = 'panelVault'
/** How long the look takes to fade into the view (ui.css `.panel-snap.is-look.is-going`). */
const LOOK_FADE_MS = 120
/** What the frame's URL says this page draws: `3` adds the Settings view (`open-view` `settings`). */
const EXT_LEVEL = 3

export async function startAsk(root: HTMLElement, server: string, win: { id?: number }, surface: 'panel' | 'popup', inTab: boolean, gone: () => boolean): Promise<void> {
  const frame = h('iframe', {
    class: 'panel-frame',
    src: `${server}/popout?view=ext-panel&ext=${EXT_LEVEL}${surface === 'popup' ? '&surface=popup' : ''}`,
    title: 'Walnut',
    allow: 'clipboard-write; microphone',
  }) as HTMLIFrameElement
  const body = h('div', { class: 'panel-body' }, frame)
  root.replaceChildren(h('div', { class: `panel-shell is-ask is-${surface}` }, body))

  // ── Ask as it will look, drawn here at once, until the view says its own is up ──
  let lookShown = true
  const look: AskLook = { surface, snap: null, shell: null, page: null, locked: true }
  const lookEl = drawAskLook(look)
  body.append(lookEl)
  const drawLook = () => { if (lookShown) drawAskLook(look, lookEl) }
  /**
   * The view said its own is up: the look goes once the frame has painted it, fading out. Gone at
   * once, the frame's last painted picture (Walnut's launch splash) showed for a frame or two
   * (the second D02 review: the centred brand mark on a warm open).
   */
  const unLook = () => {
    if (!lookShown) return
    lookShown = false
    requestAnimationFrame(() => requestAnimationFrame(() => {
      lookEl.classList.add('is-going')
      setTimeout(() => lookEl.remove(), LOOK_FADE_MS + 40)
    }))
  }
  // A view that never says so (a Walnut whose view sends no `shown`) still gets its frame back.
  setTimeout(unLook, 15_000)
  /** The page in this window and its conversation of last time, for the drawing. */
  const lookAtPage = async () => {
    const [tab] = await ext.tabs.query({ active: true, windowId: win.id })
    const url = tab?.url && /^https?:/.test(tab.url) && !tab.url.startsWith(`${server}/`) ? tab.url : ''
    let host = ''
    try { host = url ? new URL(url).host : '' } catch { /* no page */ }
    look.page = url ? { title: tab?.title ?? '', host } : null
    look.snap = url && surface === 'panel' ? await snapOf('ask', url) as AskSnap | null : null
    drawLook()
  }
  void Promise.all([
    shellOf().then((sh) => { look.shell = sh }),
    ext.storage.session.get('vaultSession').then((v) => { look.locked = !v.vaultSession }).catch(() => undefined),
    lookAtPage(),
  ]).then(drawLook)

  // ── the full views the drawer's foot opens, over the Ask frame, each kept once made ──
  const views = new Map<FullView, { el: HTMLElement; frame: HTMLIFrameElement }>()
  let current: FullView | null = null
  const showView = (v: FullView | null) => {
    current = v
    if (v && !views.has(v)) {
      const f = v === 'tasks'
        ? h('iframe', { class: 'panel-frame-tasks', src: `${server}/popout?view=ext-tasks`, title: 'Walnut tasks' }) as HTMLIFrameElement
        : h('iframe', {
          class: `panel-frame-${v}`,
          src: ext.runtime.getURL(`popup.html?embed=panel&view=1&window=${win.id ?? ''}${v === 'settings' ? '&open=settings' : ''}`),
          title: v === 'settings' ? 'Walnut settings' : 'Walnut passwords',
          allow: 'clipboard-write',
        }) as HTMLIFrameElement
      // Passwords and Settings draw their own bar (Back, the title and its tools in one row: popup.ts `inView`).
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

  // The Passwords and Settings views' own Back (popup.ts viewBack), from those frames on this extension's origin.
  window.addEventListener('message', (e) => {
    const d = e.data as { walnut?: unknown; type?: unknown } | null
    if (e.origin !== location.origin || d?.walnut !== 'panel-view' || d.type !== 'back') return
    // Only the view on screen goes back: a Back from a hidden one (late, or sent twice) leaves the shown view be.
    const shown = current === 'passwords' || current === 'settings' ? views.get(current) : undefined
    if (e.source && shown && e.source === shown.frame.contentWindow) showView(null)
  })

  // ── what Ask and Tasks showed last time, until each view says its own is up (panel-snap.ts) ──
  const covers = new Map<SnapView, HTMLElement>()
  const upViews = new Set<SnapView>()
  const uncover = (view: SnapView) => { upViews.add(view); covers.get(view)?.remove(); covers.delete(view) }
  const cover = async (view: SnapView, url?: string) => {
    // Ask is drawn by the look above; only Tasks has a drawing of last time here.
    if (view === 'ask' || surface === 'popup' || upViews.has(view) || covers.has(view)) return
    const snap = await snapOf(view, url)
    if (!snap || upViews.has(view) || covers.has(view)) return
    const el = drawSnap(view, snap)
    covers.set(view, el)
    if (view === 'tasks') views.get('tasks')?.el.append(el)
    else { el.hidden = current !== null; body.append(el) }
    // A view that never says so still gets its frame back.
    setTimeout(() => uncover(view), 15_000)
  }

  // ── the key popover and the vault it shows ──
  let told = ''
  let locked = true
  /** Moves each time the live state is told: the last known state never goes after it. */
  let liveTold = 0
  /**
   * The vault as this browser last knew it, told the moment the frame is ready (review R2-9: the
   * key wore its padlock for half a second on an unlocked vault while the live answer, a round
   * trip to Walnut, was on its way): the unlock this browser holds (its mark in storage.session,
   * as the look reads it), and this site's count when the last state told was for this site.
   */
  const lastKnown = async () => {
    const [kept, [tab]] = await Promise.all([
      ext.storage.session.get(['vaultSession', KEPT_VAULT]).catch(() => ({} as Record<string, unknown>)),
      ext.tabs.query({ active: true, windowId: win.id }).catch(() => [] as Array<{ url?: string }>),
    ])
    let host = ''
    try { host = tab?.url && /^https?:/.test(tab.url) ? new URL(tab.url).host : '' } catch { /* no page */ }
    const nowLocked = !kept.vaultSession
    const prev = kept[KEPT_VAULT] as { host?: unknown; siteCount?: unknown } | undefined
    const siteCount = !nowLocked && prev?.host === host && typeof prev.siteCount === 'number' ? prev.siteCount : null
    return { type: 'vault-state', locked: nowLocked, siteCount, host }
  }
  const tellKnown = async () => {
    const at = liveTold
    const m = await lastKnown()
    if (gone() || at !== liveTold || told) return
    page.postAsk(m)
  }
  const tellVault = async () => {
    if (gone()) return
    const st = await ask<{ connected: boolean; unlocked: boolean }>({ type: 'vault-watch' })
    if (!st.ok) return
    const nowLocked = !st.unlocked
    const [tab] = await ext.tabs.query({ active: true, windowId: win.id })
    let host = ''
    try { host = tab?.url && /^https?:/.test(tab.url) ? new URL(tab.url).host : '' } catch { /* no page */ }
    const count = nowLocked ? { ok: true, count: null } : await ask<{ count: number | null }>({ type: 'site-count', windowId: win.id })
    // Unlocked, the drawer's Passwords row always has a state (R1-13b): no site here counts as none.
    const m = { type: 'vault-state', locked: nowLocked, siteCount: nowLocked || !count.ok ? null : count.count ?? 0, host }
    const flipped = nowLocked !== locked
    locked = nowLocked
    if (flipped) key.refresh()
    if (look.locked !== nowLocked) { look.locked = nowLocked; drawLook() }
    const s = JSON.stringify(m)
    liveTold++
    if (s === told) return
    told = s
    page.postAsk(m)
    void ext.storage.session.set({ [KEPT_VAULT]: { host: m.host, siteCount: m.siteCount } }).catch(() => undefined)
  }
  const key = keyPopover({
    host: body,
    windowId: win.id,
    surface,
    inTab,
    onSearchAll: () => { if (surface === 'panel') showView('passwords'); else location.href = 'popup.html?from=ask' },
    onSettings: () => { if (surface === 'panel') showView('settings'); else location.href = 'popup.html?from=ask&open=settings' },
    onOpenVault: () => { void ask({ type: 'open-walnut' }).then(() => { if (surface === 'popup' && !inTab) window.close() }) },
    onChange: (open) => page.postAsk({ type: 'key-state', open }),
    onVault: () => void tellVault(),
    onEscape: () => frame.focus(),
  })

  /**
   * The popup's question for this window's panel: a new ask, or an ask to show. The background
   * hands it out once (R1-16: two panels of one window both read it, and one question made two asks).
   */
  const takeHand = async () => {
    if (surface !== 'panel') return
    const r = await ask<{ hand?: { ask?: unknown; open?: unknown; view?: unknown } }>({ type: 'panel-hand', windowId: win.id })
    const hand = r.ok ? r.hand : undefined
    if (!hand) return
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
    onWebPage: () => { if (lookShown) void lookAtPage() },
    onAskSelection: () => showView(null),
    // Escape in the composer never closes the side panel (R1-3); the toolbar popup closes.
    onClose: () => { if (surface === 'popup') window.close() },
    onReady: (w) => {
      if (w !== frame.contentWindow) return
      // The view is up and drawing: a Walnut whose view never says `shown` (its popup, an older
      // build) gets its own view back soon after, not at the 15 s backstop.
      setTimeout(unLook, 2500)
      told = ''
      void tellKnown()
      void tellVault()
      void takeHand()
    },
    onMessage: (d, from) => {
      if (d.type === 'theme') { keepTheme(d.theme); return }
      if (d.type === 'shown' || d.type === 'snapshot') {
        const view: SnapView = from === frame.contentWindow ? 'ask' : 'tasks'
        if (d.type === 'shown') { if (view === 'ask') unLook(); else uncover(view) }
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
          if (d.view === 'settings' && surface === 'popup') { location.href = 'popup.html?from=ask&open=settings'; return }
          if (d.view === 'tasks' || d.view === 'passwords' || d.view === 'settings') showView(d.view)
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

  // Escape on a full view goes back to Ask (R1-2); one inside the Passwords or Settings frame comes
  // as that view's Back. The key popover closes first when it is open (key-pop.ts).
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !current || key.isOpen() || e.defaultPrevented) return
    e.preventDefault()
    showView(null)
  }, true)

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
