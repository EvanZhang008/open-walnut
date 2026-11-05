/**
 * The popup's Settings: the connection, when the extension locks itself, filling and saving on
 * web pages, copying the one-time code after a fill, the sites Walnut never offers to save for (each removable), and
 * agents in this browser.
 */
import { ask, ext } from './ext'
import { nextView, paint } from './popup-view'
import { h, icon } from './dom'
import { AUTO_LOCKS, getSettings, setSettings, type AutoLock } from './settings'
import { errLine, iconButton, switchRow, topBar } from './popup-ui'
import { disconnectControl } from './popup-disconnect'
import { setTrustedInput, trustedInputState } from './trusted-switch'

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
    const fresh = await agentSection()
    wrap.replaceWith(fresh)
  }
  const trusted = await trustedRow()
  const wrap = h('div', {},
    h('div', { class: 'section-label' }, 'Agents'),
    h('div', { class: 'group' },
      h('label', { class: 'row switch-row', for: 'agents' },
        h('span', { class: 'row-text' }, h('span', { class: 'row-title' }, 'Let Walnut agents use this browser')), box),
      trusted?.row ?? null),
    note, st.on ? sites : null, err, trusted?.note ?? null)
  return wrap
}

/** Real mouse and keys for agents (the optional debugger permission); Chrome only, so hidden elsewhere. */
async function trustedRow(): Promise<{ row: HTMLElement; note: HTMLElement } | null> {
  const { available, on } = await trustedInputState()
  if (!available) return null
  const box = h('input', { type: 'checkbox', id: 'trusted', role: 'switch', 'data-testid': 'popup-trusted' }) as HTMLInputElement
  box.checked = on
  box.onclick = () => {
    // Asked inside the click: nothing is awaited before the browser's permission request.
    const want = box.checked
    void setTrustedInput(want).then((now) => { box.checked = now })
  }
  return {
    row: h('label', { class: 'row switch-row', for: 'trusted' },
      h('span', { class: 'row-text' }, h('span', { class: 'row-title' }, 'Let agents use real mouse and keys')), box),
    note: h('p', { class: 'group-note' }, 'Real mouse and keys are for sites that ignore simulated input. This also lets agents run scripts in a page, which Walnut cannot check before a purchase or a send. Chrome shows a debugging bar while an agent uses them.'),
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
      await ext.storage.local.set({ neverSave: (now ?? []).filter((s) => s !== site) })
      wrap.replaceWith(await neverSection())
    }, { 'data-testid': 'never-remove' })
    remove.setAttribute('aria-label', `Remove ${site}`)
    group.append(h('div', { class: 'never-row' }, icon('globe'), h('span', { class: 'row-title' }, site), remove))
  }
  wrap.append(group)
  return wrap
}

export async function settingsView(root: HTMLElement, st: { serverUrl?: string; device?: string }, back: () => void): Promise<void> {
  const g = nextView()
  const settings = await getSettings()
  const off = disconnectControl(st, back)
  const lock = h('select', { class: 'select', id: 'autolock', 'aria-label': 'Lock Walnut', 'data-testid': 'popup-autolock' },
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
  // What a person changes comes first (lock, filling, agents), so it fits the popup's first
  // screen; the sites never offered for saving, the connection and Disconnect close the page.
  paint(root, h('div', {},
    topBar('Settings', back),
    h('div', { class: 'pane settings' },
      h('div', { class: 'section-label' }, 'Lock'),
      // The choice on one line with its select, its help under both at full width.
      h('div', { class: 'group' }, h('div', { class: 'setting setting-stack', 'data-testid': 'popup-lock-row' },
        h('label', { class: 'row-title', for: 'autolock' }, 'Lock Walnut'), lock, lockSub)),
      h('div', { class: 'section-label' }, 'Filling'),
      h('div', { class: 'group' },
        // Off while another password manager fills this browser: no icon, menu or bar in pages (content.ts).
        switchRow('pagefill', 'Fill and save on web pages', 'Turn off while another password manager fills this browser; the popup still fills on a click.', settings.pageFill,
          (on) => void setSettings({ pageFill: on }), 'popup-pagefill'),
        switchRow('copytotp', 'Copy the one-time code after filling', 'Its code is then on the clipboard for the next page.', settings.copyTotp,
          (on) => void setSettings({ copyTotp: on }), 'popup-copytotp')),
      h('p', { class: 'group-note', 'data-testid': 'popup-shortcut-note' }, 'Ctrl+Shift+L (⌘⇧L on a Mac) fills the login for the page. In a field, the arrow keys open the menu.'),
      await agentSection(),
      await neverSection(),
      h('div', { class: 'section-label' }, 'This browser'),
      h('div', { class: 'group', 'data-testid': 'popup-connection' }, h('div', { class: 'row' }, h('span', { class: 'logo' }, icon('key')),
        h('span', { class: 'row-text' }, h('span', { class: 'row-title' }, st.serverUrl ? `Connected to ${hostOf(st.serverUrl)}` : 'Connected'), h('span', { class: 'row-sub' }, st.device ?? '')))),
      h('div', { style: 'height:10px' }), off)), g, 'neutral')
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
