/**
 * The side panel, and the toolbar popup, as Walnut's own Ask (a Walnut whose panel answer says
 * `askPanel`): one frame, `/popout?view=ext-panel&ext=2` (`&surface=popup` in the popup), whose
 * header has the ≡ drawer of asks and a key button. This page draws what Walnut's page must not:
 * the side bar on the left (panel-rail.ts: Chat and Browser control are the frame, Passwords and
 * Settings the extension's own views, embedded), the key popover over the frame (key-pop.ts), and
 * the Tasks view with its Back, which the approvals' "more" opens.
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
import { agentNameOf, agentOf, drawSnap, drawTasksLoading, homeOf, keepAgent, keepHomeSnap, keepMode, keepSnap, shellOf, snapKeyOf, snapOf, type AskSnap, type PanelMode } from './panel-snap'
import { drawAskLook, type AskLook } from './panel-look'
import { drawControlLook, drawHomeLook, drawTaskLook, type HomeLook, type RelayLook } from './panel-look-home'
import { drawRail, keepRail, railOf, type RailEntry } from './panel-rail'
import { startPagePlumbing } from './panel-page'
import { keyPopover } from './key-pop'
import { keepTheme } from './panel-theme'

/**
 * The views over the frame: the side bar's Passwords and Settings, and Tasks, the whole list of
 * approvals and asks that the approvals' "more" opens (Chat's first page holds the rest of it).
 */
type FullView = 'tasks' | 'passwords' | 'settings'
/** The vault state this page last told its frame (storage.session: gone with the browser), for the next open's first word. */
const KEPT_VAULT = 'panelVault'
/** How often an open panel or popup asks Walnut how the vault stands, while it is on screen. */
export const VAULT_LOOK_MS = 1000
/** How long the look takes to fade into the view (ui.css `.panel-snap.is-look.is-going`). */
const LOOK_FADE_MS = 120
/**
 * What the frame's URL says this page draws: `3` adds the Settings view (`open-view` `settings`),
 * `4` the side bar (panel-rail.ts: Chat, Passwords, Browser control, Settings).
 */
const EXT_LEVEL = 4

export async function startAsk(root: HTMLElement, server: string, win: { id?: number }, surface: 'panel' | 'popup', inTab: boolean, gone: () => boolean): Promise<void> {
  const frame = h('iframe', {
    class: 'panel-frame',
    src: `${server}/popout?view=ext-panel&ext=${EXT_LEVEL}${surface === 'popup' ? '&surface=popup' : ''}`,
    title: 'Walnut',
    allow: 'clipboard-write; microphone',
  }) as HTMLIFrameElement
  const body = h('div', { class: 'panel-body' }, frame)
  // ── the side bar: drawn here at once, on the entry the person left it on ──
  /** The frame's own entry on show (Chat or Browser control), under a Passwords or Settings view too. */
  let frameEntry: 'chat' | 'control' = 'chat'
  const rail = drawRail(surface, (entry) => pick(entry))
  rail.select('chat')
  /** The entry it was left on: the drawing below is of it, and it opens once this page is set up (the end). */
  const railKept = railOf(surface)
  root.replaceChildren(h('div', { class: `panel-shell is-ask is-${surface} has-rail` }, rail.el, body))

  // ── the view as it will look, drawn here at once, until it says its own is up ──
  // The page it opens on: the popup always the first page (New task), the side panel the page it
  // was left on (the first page, an ask, or a task opened there), as the view said (`mode`).
  let lookShown = true
  const look: AskLook = { surface, snap: null, shell: null, page: null, locked: true }
  const homeLook: HomeLook = { surface, home: null, page: null, locked: true, relay: 'off', settings: false }
  let lookMode: PanelMode = 'home'
  let lookTask = ''
  const lookEl = h('div', { class: `panel-snap panel-snap-ask is-look is-${surface}`, 'data-testid': 'panel-snap', 'aria-hidden': 'true' })
  const drawLook = () => {
    if (!lookShown) return
    if (frameEntry === 'control') drawControlLook({ relay: homeLook.relay, locked: look.locked }, lookEl)
    else if (lookMode === 'ask') drawAskLook(look, lookEl)
    else if (lookMode === 'task') drawTaskLook({ title: lookTask, locked: look.locked }, lookEl)
    else drawHomeLook({ ...homeLook, locked: look.locked }, lookEl)
  }
  drawLook()
  body.append(lookEl)
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
  /** The agent the drawing is of: the one the Ask view was last on ('' for none known: the bare Ask). */
  let lookAgent: string | null = null
  /** The page in this window and its conversation of last time, for the drawing. */
  const lookAtPage = async () => {
    const [tab] = await ext.tabs.query({ active: true, windowId: win.id })
    const url = tab?.url && /^https?:/.test(tab.url) && !tab.url.startsWith(`${server}/`) ? tab.url : ''
    let host = ''
    try { host = url ? new URL(url).host : '' } catch { /* no page */ }
    look.page = url ? { title: tab?.title ?? '', host, key: snapKeyOf(url) } : null
    homeLook.page = url ? { title: tab?.title ?? '', host } : null
    drawLook()
  }
  /** The relay pill of the drawing: an agent in this tab, the agents switch, or tabs handed over. */
  const lookAtRelay = async () => {
    const [local, session, [tab]] = await Promise.all([
      ext.storage.local.get('agentControl').catch(() => ({} as Record<string, unknown>)),
      ext.storage.session.get('agentTabs').catch(() => ({} as Record<string, unknown>)),
      ext.tabs.query({ active: true, windowId: win.id }).catch(() => [] as Array<{ id?: number }>),
    ])
    const tabs = (session.agentTabs ?? {}) as Record<string, unknown>
    const relay: RelayLook = tab?.id !== undefined && tabs[String(tab.id)] ? 'tab' : local.agentControl === true || Object.keys(tabs).length > 0 ? 'on' : 'off'
    homeLook.relay = relay
    drawLook()
  }
  /**
   * The open conversation and the shell of the agent the view opens on, on any page (a tab with no
   * web page too): the view keeps one conversation per agent, and opens on the agent picked last in
   * any window. With no agent known, none: a conversation of another agent must never stand in
   * (round 3 code review, item 3).
   */
  const lookAtAgent = async (agent: string, name?: string) => {
    lookAgent = agent
    const [snap, shell, kept] = await Promise.all([
      surface === 'panel' && agent ? snapOf('ask', undefined, Date.now(), agent) as Promise<AskSnap | null> : Promise.resolve(null),
      agent ? shellOf(Date.now(), agent) : Promise.resolve(null),
      name === undefined && agent ? agentNameOf() : Promise.resolve(name ?? ''),
    ])
    if (lookAgent !== agent) return
    look.snap = snap
    look.shell = shell
    look.agentName = kept || undefined
    drawLook()
  }
  void Promise.all([
    railKept.then((e) => { if (e === 'control') { frameEntry = 'control'; rail.select('control') } }),
    homeOf().then(({ home, mode }) => {
      homeLook.home = home
      if (surface === 'panel' && mode) { lookMode = mode.mode; lookTask = mode.title ?? '' }
    }),
    lookAtRelay(),
    agentOf().then((a) => (lookAgent === null ? lookAtAgent(a) : undefined)),
    ext.storage.session.get('vaultSession').then((v) => { look.locked = !v.vaultSession }).catch(() => undefined),
    lookAtPage(),
  ]).then(drawLook)

  // ── the views over the frame (the side bar's Passwords and Settings, and Tasks), each kept once made ──
  const views = new Map<FullView, { el: HTMLElement; frame: HTMLIFrameElement }>()
  let current: FullView | null = null
  /** Show a view (null: the frame, on its entry). Tasks is part of Chat: the side bar marks Chat under it. */
  const showView = (v: FullView | null) => {
    current = v
    rail.select(v === 'passwords' || v === 'settings' ? v : v === 'tasks' ? 'chat' : frameEntry)
    if (v && !views.has(v)) {
      const f = v === 'tasks'
        ? h('iframe', { class: 'panel-frame-tasks', src: `${server}/popout?view=ext-tasks`, title: 'Walnut tasks' }) as HTMLIFrameElement
        : h('iframe', {
          class: `panel-frame-${v}`,
          src: ext.runtime.getURL(`popup.html?embed=panel&view=1&rail=1&window=${win.id ?? ''}${v === 'settings' ? '&open=settings' : ''}`),
          title: v === 'settings' ? 'Walnut settings' : 'Walnut passwords',
          allow: 'clipboard-write',
        }) as HTMLIFrameElement
      // Passwords and Settings draw their own bar (the title and its tools in one row: popup.ts `inView`).
      const el = h('div', { class: 'panel-view', 'data-testid': `panel-view-${v}` },
        v === 'tasks' ? h('div', { class: 'panel-view-bar' },
          h('button', { class: 'back-btn', type: 'button', 'data-testid': 'panel-view-back', onclick: () => showView(null) }, popupIcon('back'), h('span', {}, 'Chat')),
          h('span', { class: 'panel-view-title' }, 'Tasks')) : null,
        f)
      views.set(v, { el, frame: f })
      body.append(el)
      if (v === 'tasks') void coverTasks()
    }
    for (const [k, x] of views) x.el.hidden = k !== v
    key.close()
    if (!v) frame.focus()
  }

  /**
   * Back to the frame from the view on show: from Passwords or Settings that is a side bar pick of
   * the frame's entry, so the next open opens there too, not on the view just left.
   */
  const back = () => {
    if (current === 'passwords' || current === 'settings') pick(frameEntry)
    else showView(null)
  }

  // The Passwords and Settings views' own Back (popup.ts viewBack), from those frames on this extension's origin.
  window.addEventListener('message', (e) => {
    const d = e.data as { walnut?: unknown; type?: unknown } | null
    if (e.origin !== location.origin || d?.walnut !== 'panel-view' || d.type !== 'back') return
    // Only the view on screen goes back: a Back from a hidden one (late, or sent twice) leaves the shown view be.
    const shown = current === 'passwords' || current === 'settings' ? views.get(current) : undefined
    if (e.source && shown && e.source === shown.frame.contentWindow) back()
  })

  // ── what the Tasks view showed last time, until it says its own is up (panel-snap.ts) ──
  let tasksCover: HTMLElement | null = null
  let tasksUp = false
  const uncoverTasks = () => { tasksUp = true; tasksCover?.remove(); tasksCover = null }
  const coverTasks = async () => {
    if (surface === 'popup' || tasksUp || tasksCover) return
    const snap = await snapOf('tasks')
    if (tasksUp || tasksCover) return
    // Never shown here before: its loading line in its places, not the frame's blank page.
    tasksCover = snap ? drawSnap('tasks', snap) : drawTasksLoading()
    views.get('tasks')?.el.append(tasksCover)
    // A view that never says so still gets its frame back.
    setTimeout(uncoverTasks, 15_000)
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
  /** One look at a time: a call while one runs gets one more look after it, so none piles up behind a slow Walnut. */
  let looking: Promise<void> | null = null
  let again = false
  const tellVault = (): Promise<void> => {
    if (looking) { again = true; return looking }
    looking = lookVault().finally(() => {
      looking = null
      if (again) { again = false; void tellVault() }
    })
    return looking
  }
  const lookVault = async () => {
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
    onSearchAll: () => pick('passwords'),
    onSettings: () => pick('settings'),
    onOpenVault: () => { void ask({ type: 'open-walnut' }).then(() => { if (surface === 'popup' && !inTab) window.close() }) },
    onChange: (open) => page.postAsk({ type: 'key-state', open }),
    onVault: () => void tellVault(),
    onEscape: () => frame.focus(),
  })

  /**
   * The frame's entry: Chat (`home`: on its first page, the task list) or Browser control. Told to
   * the frame at once, or when it says it is ready (onReady below).
   */
  const toFrameEntry = (entry: 'chat' | 'control', home = false) => {
    frameEntry = entry
    page.postAsk({ type: 'rail', entry, ...(home ? { home: true } : {}) })
  }
  /** The person picked a side bar entry (or something opened one): show it, and keep it for the next open. */
  function pick(entry: RailEntry): void {
    void keepRail(surface, entry)
    if (entry === 'passwords' || entry === 'settings') { showView(entry); return }
    toFrameEntry(entry)
    showView(null)
    if (lookShown) drawLook()
  }

  /**
   * The popup's question for this window's panel: a new ask, or an ask to show. The background
   * hands it out once (R1-16: two panels of one window both read it, and one question made two asks).
   */
  const takeHand = async () => {
    if (surface !== 'panel') return
    const r = await ask<{ hand?: { ask?: unknown; open?: unknown; view?: unknown } }>({ type: 'panel-hand', windowId: win.id })
    const hand = r.ok ? r.hand : undefined
    if (!hand) return
    if (hand.view === 'tasks') { pick('chat'); showView('tasks'); return }
    // What the popup handed over shows in Chat.
    pick('chat')
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
    onAskSelection: () => back(),
    // Escape in the composer never closes the side panel (R1-3); the toolbar popup closes.
    onClose: () => { if (surface === 'popup') window.close() },
    onReady: (w) => {
      if (w !== frame.contentWindow) return
      // The view is up and drawing: a Walnut whose view never says `shown` (its popup, an older
      // build) gets its own view back soon after, not at the 15 s backstop.
      setTimeout(unLook, 2500)
      told = ''
      page.postAsk({ type: 'rail', entry: frameEntry })
      void tellKnown()
      void tellVault()
      void takeHand()
    },
    onMessage: (d, from) => {
      if (d.type === 'theme') { keepTheme(d.theme); return }
      // A Lock (or an unlock) anywhere: Walnut's frame heard it as it happened; the key, the popover
      // and the drawer's row follow now, not at the next look (review R3-6).
      if (d.type === 'vault-changed') { told = ''; void tellVault(); return }
      if (d.type === 'agent') {
        if (from !== frame.contentWindow) return
        const name = typeof d.name === 'string' ? d.name.slice(0, 60) : ''
        void keepAgent(d.agentId, Date.now(), name)
        // Still drawing another agent's words (the pick moved meanwhile): this agent's now.
        if (lookShown && typeof d.agentId === 'string' && d.agentId !== lookAgent) void lookAtAgent(d.agentId, name)
        return
      }
      if (d.type === 'shown' || d.type === 'snapshot') {
        if (from === views.get('tasks')?.frame.contentWindow) {
          if (d.type === 'shown') uncoverTasks()
          else if (d.view === 'tasks') void keepSnap('tasks', d.snap, { key: d.key, agentId: d.agentId, counts: d.counts })
          return
        }
        if (from !== frame.contentWindow) return
        if (d.type === 'shown') unLook()
        // The first page's task panel (Chat's first page), and the Ask page's words.
        else if (d.view === 'home') void keepHomeSnap(d.snap)
        else if (d.view === 'ask') void keepSnap('ask', d.snap, { key: d.key, agentId: d.agentId, counts: d.counts })
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
        // The page the side panel's view shows now: the next open draws that one.
        case 'mode':
          if (surface === 'panel') void keepMode(d.mode, d.title)
          return
        case 'open-view':
          // The side bar's entries, in the popup too (design C): never a page of its own.
          if (d.view === 'passwords' || d.view === 'settings') pick(d.view)
          // The approvals' "more": the whole list, over Chat.
          else if (d.view === 'tasks') { pick('chat'); showView('tasks') }
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
    back()
  }, true)

  // The side bar's entry of last time (Chat needs nothing: the frame opens on it).
  void railKept.then((e) => { if (e !== 'chat' && !gone()) pick(e) })

  // The vault as Walnut sees it now (popup.ts followVault): a Lock all elsewhere locks the key here
  // within about a second, an unlock in a Walnut window unlocks it. The frame's `vault-changed` is
  // the quick way; this look is for a Walnut whose frame does not say it (review R3-6: 1.5 to 2.5 s
  // at a look every 3 s).

  setInterval(() => { if (document.visibilityState === 'visible') void tellVault() }, VAULT_LOOK_MS)
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
