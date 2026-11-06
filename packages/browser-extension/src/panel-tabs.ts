/**
 * The side panel for a Walnut older than the Ask panel (its panel answer has no `askPanel`): three
 * tabs, the one picked kept for the next time (storage.local `panelTab`). Ask (`/popout?view=ext-panel`),
 * Tasks (`/popout?view=ext-tasks`: what needs the person, their Focus tasks, the page saved as a
 * task; it hears the same page messages) and Passwords (this extension's own vault view, popup.html
 * in its panel form, for the logins of the page in this window). Each tab's frame is made the first
 * time it is shown and then kept, so a tab keeps its state.
 */
import { ext } from './ext'
import { h } from './dom'
import { drawSnap, keepSnap, snapOf, type SnapView } from './panel-snap'
import { startPagePlumbing } from './panel-page'

type PanelTab = 'ask' | 'tasks' | 'passwords'
const PANEL_TABS: ReadonlyArray<[PanelTab, string]> = [['ask', 'Ask'], ['tasks', 'Tasks'], ['passwords', 'Passwords']]

export async function startTabs(root: HTMLElement, server: string, win: { id?: number }, gone: () => boolean): Promise<void> {
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
  if (gone()) return
  root.replaceChildren(h('div', { class: 'panel-shell' }, bar, body))
  show(PANEL_TABS.some(([id]) => id === keptTab) ? keptTab as PanelTab : 'ask')

  startPagePlumbing({
    server, win, askFrame: frame, gone,
    frames: () => [made.get('ask'), made.get('tasks')],
    onWebPage: (url) => void cover('ask', url),
    onAskSelection: () => show('ask'),
    onMessage: (d, from) => {
      if (d.type !== 'shown' && d.type !== 'snapshot') return
      const view: SnapView = from === frame.contentWindow ? 'ask' : 'tasks'
      if (d.type === 'shown') uncover(view)
      else if (d.view === view) void keepSnap(view, d.snap, { key: d.key, counts: d.counts })
    },
  })
}
