/**
 * The popup's Settings: the connection, when the extension locks itself, filling and saving on
 * web pages, copying the one-time code after a fill, the sites Walnut never offers to save for (each removable), and
 * agents in this browser (with the look of their cursor).
 */
import { ask, ext } from './ext'
import { followStorage, isCurrent, nextView, paint } from './popup-view'
import { h, icon } from './dom'
import { AUTO_LOCKS, getSettings, setSettings, type AutoLock } from './settings'
import { errLine, iconButton, popupIcon, switchRow, topBar } from './popup-ui'
import { disconnectControl } from './popup-disconnect'
import { cursorPickRow } from './popup-cursor-pick'
import { setLivePictures, setTrustedInput, trustedInputState } from './trusted-switch'

/** The live pictures switch's name (the Browser view's lines name it: web/src/components/sessions/browser-view-model.ts). */
export const LIVE_PICTURES_TITLE = "Live pictures through Chrome's debugger"

/** Agents in this browser: off until the person turns it on here. */
async function agentSection(): Promise<HTMLElement> {
  const st = await ask<{ on: boolean; tabs: number; screenshots: boolean }>({ type: 'agent-get' })
  const box = h('input', { type: 'checkbox', id: 'agents', 'data-testid': 'popup-agents', role: 'switch' }) as HTMLInputElement
  box.checked = !!st.on
  const note = h('p', { class: 'group-note', 'data-testid': 'popup-agents-note' },
    st.on
      ? `On. Agents open their own tabs in a separate Walnut window${st.tabs ? ` (${st.tabs} open now)` : ''}, never in yours. They ask you before they send, buy, post or delete anything in your name.`
      : 'When this is on, your Walnut agents can open pages in this browser, signed in as you, read them, click and type. They use only tabs they open, in a window of their own, and ask you before they send, buy, post or delete anything in your name.')
  // Which sites they may open is chosen in Walnut itself.
  const sites = h('p', { class: 'group-note' }, 'You choose which sites they may open in Walnut. ',
    h('button', { class: 'link-btn', type: 'button', 'data-testid': 'popup-agent-sites', onclick: () => void ask({ type: 'open-walnut', to: 'settings' }) }, 'Choose sites'))
  const err = errLine()
  box.onchange = async () => {
    err.textContent = ''
    if (box.checked) {
      const r = await ask({ type: 'agent-on' })
      if (!r.ok) { box.checked = false; err.textContent = r.error ?? 'Could not turn it on.'; return }
    } else {
      await ask({ type: 'agent-off' })
    }
    // The switch's own change is stored (agentControl): Settings draws this section again from it.
  }
  const trusted = await trustedRow()
  const wrap = h('div', {},
    h('div', { class: 'section-label' }, 'Agents'),
    h('div', { class: 'group' },
      h('label', { class: 'row switch-row', for: 'agents' },
        h('span', { class: 'row-text' }, h('span', { class: 'row-title' }, 'Let Walnut agents use this browser')), box),
      ...(trusted?.rows ?? [])),
    note, st.on ? sites : null, err, ...(trusted?.notes ?? []))
  return wrap
}

/**
 * Real mouse and keys for agents, and live pictures of agents' tabs: both use the debugger
 * permission (trusted-switch.ts), each with its own switch, both on by default; Chrome only, so
 * hidden elsewhere.
 */
async function trustedRow(): Promise<{ rows: HTMLElement[]; notes: HTMLElement[] } | null> {
  const st = await trustedInputState()
  if (!st.available) return null
  const box = h('input', { type: 'checkbox', id: 'trusted', role: 'switch', 'data-testid': 'popup-trusted' }) as HTMLInputElement
  box.checked = st.on
  const live = h('input', { type: 'checkbox', id: 'live-pictures', role: 'switch', 'data-testid': 'popup-live-pictures' }) as HTMLInputElement
  live.checked = st.livePictures
  // Each switch's answer; the permission may have come or gone with it, which the other one reads.
  const reread = () => void trustedInputState().then((now) => { box.checked = now.on; live.checked = now.livePictures })
  box.onclick = () => {
    // Asked inside the click: nothing is awaited before the browser's permission request.
    const want = box.checked
    void setTrustedInput(want).then(reread)
  }
  live.onclick = () => {
    const want = live.checked
    void setLivePictures(want).then(reread)
  }
  return {
    rows: [
      h('label', { class: 'row switch-row', for: 'trusted' },
        h('span', { class: 'row-text' }, h('span', { class: 'row-title' }, 'Let agents use real mouse and keys')), box),
      h('label', { class: 'row switch-row', for: 'live-pictures' },
        h('span', { class: 'row-text' }, h('span', { class: 'row-title' }, LIVE_PICTURES_TITLE)), live)],
    notes: [
      h('p', { class: 'group-note' }, "Agents click and type in their own tabs with the browser's mouse and keys, as you would, so sites that ignore simulated input work too. A purchase, a send or a delete still waits for your yes. This also lets agents run scripts in a page, which Walnut cannot check before a purchase or a send. Chrome shows its debugging bar while an agent works."),
      h('p', { class: 'group-note', 'data-testid': 'popup-live-pictures-note' }, "Chrome stops drawing Walnut's agent window while other windows cover it or it is minimized, and draws only the front tab. With live pictures on, a task's Browser view in Walnut still shows the agent's tab, through Chrome's debugger, without bringing anything forward; Chrome shows its debugging bar while it does.")],
  }
}

/** "Never for this site": each one listed, and taken off with its own button. */
async function neverSection(): Promise<HTMLElement> {
  const { neverSave } = await ext.storage.local.get('neverSave')
  const sites = Array.isArray(neverSave) ? (neverSave as string[]) : []
  const wrap = h('div', { 'data-testid': 'never-list' }, h('div', { class: 'section-label' }, 'Never offer to save on'))
  if (!sites.length) { wrap.append(h('p', { class: 'group-note', style: 'margin-top:0' }, 'No sites yet. "Never for this site" on the save bar adds one here.')); return wrap }
  const group = h('div', { class: 'group' })
  for (const site of sites) {
    const remove = iconButton(icon('x'), `Offer to save on ${site} again`, async () => {
      const now = (await ext.storage.local.get('neverSave')).neverSave as string[] | undefined
      // Stored, and Settings draws the list again from it (settingsView follows `neverSave`).
      await ext.storage.local.set({ neverSave: (now ?? []).filter((s) => s !== site) })
    }, { 'data-testid': 'never-remove' })
    remove.setAttribute('aria-label', `Remove ${site}`)
    group.append(h('div', { class: 'never-row' }, icon('globe'), h('span', { class: 'row-title' }, site), remove))
  }
  wrap.append(group)
  return wrap
}

/**
 * `backLabel`: where Back goes, when it is not the view this one was opened from ("Ask"): the page
 * was opened on Settings (popup.ts `openSettings`), so Settings is its home view and stays so.
 */
export async function settingsView(root: HTMLElement, st: { serverUrl?: string; device?: string }, back: () => void, backLabel?: string): Promise<void> {
  const g = nextView()
  const settings = await getSettings()
  const off = disconnectControl(st, back)
  const lock = h('select', { class: 'select', id: 'autolock', 'aria-label': 'Lock passwords', 'data-testid': 'popup-autolock' },
    ...AUTO_LOCKS.map((a) => h('option', { value: a.value }, a.label))) as HTMLSelectElement
  lock.value = settings.autoLock
  // How long it stays unlocked, in plain words: Walnut's own length, or the time picked here.
  const lockSub = h('span', { class: 'row-sub', 'data-testid': 'popup-autolock-help' }, lockHelp(lock.value as AutoLock, undefined))
  let walnutSt: WalnutLength | undefined
  lock.onchange = () => { void setSettings({ autoLock: lock.value as AutoLock, autoLockChosen: true }); lockSub.textContent = lockHelp(lock.value as AutoLock, walnutSt) }
  void ask({ type: 'vault-status' }).then((r) => {
    walnutSt = (r as { status?: WalnutLength } | undefined)?.status
    lockSub.textContent = lockHelp(lock.value as AutoLock, walnutSt)
  }).catch(() => undefined)
  const agentsBox = h('div', { 'data-testid': 'popup-agents-section' }, await agentSection())
  // Outside agentsBox, which is drawn again when agents are turned on or off.
  const cursorPick = cursorPickRow(settings.cursorStyle)
  const neverBox = h('div', {}, await neverSection())
  // What a person changes comes first (lock, filling, agents), so it fits the popup's first
  // screen; the sites never offered for saving, the connection and Disconnect close the page.
  const painted = paint(root, h('div', {},
    backLabel
      ? h('div', { class: 'top top-sub view-bar' }, h('button', { class: 'back-btn', type: 'button', 'data-testid': 'panel-view-back', onclick: back }, popupIcon('back'), h('span', {}, backLabel)), h('h1', {}, 'Settings'))
      : topBar('Settings', back),
    h('div', { class: 'pane settings' },
      h('div', { class: 'section-label' }, 'Lock'),
      // The choice on one line with its select, its help under both at full width.
      h('div', { class: 'group' }, h('div', { class: 'setting setting-stack', 'data-testid': 'popup-lock-row' },
        h('label', { class: 'row-title', for: 'autolock' }, 'Lock passwords'), lock, lockSub)),
      h('div', { class: 'section-label' }, 'Filling'),
      h('div', { class: 'group' },
        // Off while another password manager fills this browser: no icon, menu or bar in pages (content.ts).
        switchRow('pagefill', 'Fill and save on web pages', 'Turn off while another password manager fills this browser; the popup still fills on a click.', settings.pageFill,
          (on) => void setSettings({ pageFill: on }), 'popup-pagefill'),
        switchRow('copytotp', 'Copy the one-time code after filling', 'Its code is then on the clipboard for the next page.', settings.copyTotp,
          (on) => void setSettings({ copyTotp: on }), 'popup-copytotp')),
      h('p', { class: 'group-note', 'data-testid': 'popup-shortcut-note' }, 'Ctrl+Shift+L (⌘⇧L on a Mac) fills the login for the page. In a field, the arrow keys open the menu.'),
      agentsBox,
      h('div', { class: 'group' }, cursorPick.row),
      neverBox,
      h('div', { class: 'section-label' }, 'This browser'),
      h('div', { class: 'group', 'data-testid': 'popup-connection' }, h('div', { class: 'row' }, h('span', { class: 'logo' }, icon('key')),
        h('span', { class: 'row-text' }, h('span', { class: 'row-title' }, st.serverUrl ? `Connected to ${hostOf(st.serverUrl)}` : 'Connected'), h('span', { class: 'row-sub' }, st.device ?? '')))),
      h('div', { style: 'height:10px' }), off)), g, 'neutral', backLabel ? 'home' : 'sub')
  if (!painted) return
  // What it shows follows the storage it reads while it is on show (review R3-5): a site the save
  // bar's "Never for this site" adds (in a page, while this panel is open), a setting changed in
  // another window, agents turned on or off elsewhere.
  const redraw = async (box: HTMLElement, make: () => Promise<HTMLElement>) => {
    const fresh = await make()
    if (isCurrent(g)) box.replaceChildren(fresh)
  }
  followStorage(['neverSave'], g, () => void redraw(neverBox, neverSection))
  followStorage(['agentControl'], g, () => void redraw(agentsBox, agentSection))
  followStorage(['settings'], g, () => void getSettings().then((now) => {
    if (!isCurrent(g)) return
    if (document.activeElement !== lock && lock.value !== now.autoLock) { lock.value = now.autoLock; lockSub.textContent = lockHelp(lock.value as AutoLock, walnutSt) }
    cursorPick.sync(now.cursorStyle)
    for (const [id, on] of [['pagefill', now.pageFill], ['copytotp', now.copyTotp]] as const) {
      const box = root.querySelector<HTMLInputElement>(`#${id}`)
      if (box && box.checked !== on) box.checked = on
    }
  }))
}

/** Walnut's "Keep Passwords unlocked" (src/core/vault/unlock-length.ts), as its own Settings words it. */
interface WalnutLength { unlockFor?: string; lockAfterIdleMinutes?: number | null; autoLockMinutes?: number }

function walnutLength(st: WalnutLength | undefined): string {
  switch (st?.unlockFor) {
    case 'idle': return `Locks after ${st.lockAfterIdleMinutes ?? st.autoLockMinutes ?? 15} minutes unused.`
    case '1h': return 'Stays unlocked for 1 hour.'
    case '12h': return 'Stays unlocked for 12 hours.'
    case 'restart': return 'Stays unlocked until Walnut restarts.'
    case 'always': return 'Stays unlocked; agents can use it while you are away.'
    case '48h': return 'Stays unlocked for 48 hours after you last use it, until you lock it or the computer Walnut runs on restarts.'
    default:
      // Not read yet, or an older Walnut that names only its idle minutes.
      return st?.autoLockMinutes ? `Locks after ${st.autoLockMinutes} minutes unused.` : 'Stays unlocked as long as Walnut keeps Passwords unlocked.'
  }
}

function lockHelp(choice: AutoLock, st: WalnutLength | undefined): string {
  if (choice === 'walnut') return `${walnutLength(st)} Change it in Walnut, Settings, Passwords.`
  if (choice === 'never') return 'Locks when the browser closes, or as Walnut is set if sooner.'
  if (choice === 'browser') return 'Locks when the browser closes or the computer locks, or as Walnut is set if sooner.'
  return 'Locks after this long with no use, when the computer locks, and when the browser closes.'
}

function hostOf(url: string): string {
  try { return new URL(url).host } catch { return url }
}
