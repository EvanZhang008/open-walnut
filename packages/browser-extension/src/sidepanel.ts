/**
 * The browser's side panel (Chrome's side panel, Firefox's sidebar), and the toolbar popup on Ask
 * (popup-ask.html runs this same page in its popup form): Walnut's own page framed here, told by
 * postMessage about the page the person is on in this window (panel-page.ts). It hears only from
 * its frames, on the connected Walnut's origin, and tells only them.
 *
 * Which shape it takes is the connected Walnut's to say (its panel answer, background.ts
 * `panel-state`): Walnut's own Ask with the key button whose popover this page draws (panel-ask.ts),
 * or, for a Walnut older than that, the three tabs Ask, Tasks and Passwords (panel-tabs.ts). The
 * popup form needs the Ask shape: with an older Walnut, or none connected, it is the vault popup
 * (popup.html), as before.
 */
import { ask, ext } from './ext'
import { h } from './dom'
import { PANEL_ASK_KEY, PANEL_SERVER_KEY, clearPanelData } from './panel-data'
import { startTabs } from './panel-tabs'
import { startAsk } from './panel-ask'

const root = document.getElementById('root')!
/** The toolbar popup's form of this page (popup-ask.html). */
const surface: 'panel' | 'popup' = document.documentElement.classList.contains('askpop') ? 'popup' : 'panel'
const params = new URLSearchParams(location.search)
// The popup form in a window of its own (a test's tab): as large as that window.
if (surface === 'popup' && params.has('window')) document.documentElement.classList.add('wide')

function message(title: string, body: string, action?: { label: string; run: () => void }): void {
  root.replaceChildren(h('div', { class: 'center' },
    h('h2', {}, title),
    h('p', {}, body),
    action ? h('button', { class: 'btn btn-primary', type: 'button', onclick: action.run }, action.label) : null))
}

/** The Walnut the panel showed last time, and its shape: its frames start loading before the background answers. */
const KEPT_SERVER = PANEL_SERVER_KEY
const KEPT_ASK = PANEL_ASK_KEY

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

type PanelState = { ok: boolean; connected?: boolean; serverUrl?: string; panel?: boolean; askPanel?: boolean }

/** The popup with no Ask to show: the vault popup it always was (connect, unlock, logins). */
function toVaultPopup(): void {
  closeFrames()
  location.replace('popup.html')
}

/** The connected Walnut's origin, or null with the panel saying why there is none. */
function serverOf(st: PanelState): string | null {
  if (!st.ok || !st.connected || !st.serverUrl) {
    if (surface === 'popup') toVaultPopup()
    else message(...CONNECT)
    return null
  }
  if (st.panel === false) {
    if (surface === 'popup') toVaultPopup()
    else message('Update Walnut', 'The Walnut this browser is connected to is older than this extension and has no side panel yet. Update Walnut, then open this panel again.')
    return null
  }
  return new URL(st.serverUrl).origin
}

async function start(): Promise<void> {
  // The background checks the connection with a round trip to Walnut; the Walnut of last time
  // starts loading meanwhile, and the answer replaces it only when it says otherwise.
  const keptAll = await ext.storage.local.get([KEPT_SERVER, KEPT_ASK])
  const kept = keptAll[KEPT_SERVER]
  const keptAsk = keptAll[KEPT_ASK]
  const state = ask<PanelState>({ type: 'panel-state' })
  let server: string
  let asks: boolean
  if (typeof kept === 'string' && kept && typeof keptAsk === 'boolean') {
    server = kept
    asks = keptAsk
    void state.then((st) => {
      if (!st.ok) return // the background did not answer: the frame of last time stays
      const now = serverOf(st)
      // `askPanel` unknown (Walnut did not answer): the shape of last time stays.
      if (now === kept && (st.askPanel === undefined || st.askPanel === keptAsk)) return
      if (now) { void ext.storage.local.set({ [KEPT_SERVER]: now, ...(st.askPanel !== undefined ? { [KEPT_ASK]: st.askPanel } : {}) }).then(() => location.reload()); return }
      // No Walnut now: the frame of last time goes, and with no connection what it showed too.
      closeFrames()
      if (!st.connected) void clearPanelData()
      else void ext.storage.local.set({ [KEPT_SERVER]: '' })
    })
  } else {
    const st = await state
    const now = serverOf(st)
    if (!now) return
    server = now
    asks = st.askPanel === true
    void ext.storage.local.set({ [KEPT_SERVER]: now, ...(st.askPanel !== undefined ? { [KEPT_ASK]: st.askPanel } : {}) })
  }
  if (surface === 'popup' && !asks) { toVaultPopup(); return }
  // Opened as a window of its own (a browser with no side panel, or a test's tab), it follows the window it was opened for.
  const forWindow = Number(params.get('window'))
  const ownWindow = Number.isInteger(forWindow) && forWindow > 0
  const win = ownWindow ? { id: forWindow } : await ext.windows.getCurrent()
  if (gone) return
  if (asks) await startAsk(root, server, win, surface, ownWindow, () => gone)
  else await startTabs(root, server, win, () => gone)

  ext.storage.onChanged.addListener((changes, area) => {
    // Disconnected while open (panel-data.ts removes the server): the Walnut frames go now.
    if (area === 'local' && KEPT_SERVER in changes && !changes[KEPT_SERVER].newValue && !gone) {
      closeFrames()
      if (surface === 'popup') toVaultPopup()
      else message(...CONNECT)
    }
  })
}

void start()
