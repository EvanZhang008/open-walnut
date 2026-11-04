/**
 * The popup's Settings: the connection, when the extension locks itself, copying the
 * one-time code after a fill, the sites Walnut never offers to save for (each removable), and
 * agents in this browser.
 */
import { ask, ext } from './ext'
import { h, icon } from './dom'
import { AUTO_LOCKS, getSettings, setSettings, type AutoLock } from './settings'
import { errLine, switchRow, topBar } from './popup-ui'
import { setTrustedInput, trustedInputState } from './trusted-switch'

/** Agents in this browser: off until the person turns it on here. */
async function agentSection(): Promise<HTMLElement> {
  const st = await ask<{ on: boolean; tabs: number; screenshots: boolean }>({ type: 'agent-get' })
  const box = h('input', { type: 'checkbox', id: 'agents', 'data-testid': 'popup-agents', role: 'switch' }) as HTMLInputElement
  box.checked = !!st.on
  const note = h('p', { class: 'muted', style: 'margin:6px 4px 0;font-size:12px' },
    st.on
      ? `On. Agents open their own tabs in a separate Walnut window${st.tabs ? ` (${st.tabs} open now)` : ''}, never yours. They ask you before sending, buying, posting or deleting anything in your name. Which sites they may use: Walnut, Settings, Browser extension.`
      : 'Turning this on lets your Walnut agents open web pages in this browser (signed in as you), read them, click and type, with no ask per site. They use only tabs they open, in their own window, and ask you before sending, buying, posting or deleting in your name.')
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
  const wrap = h('div', {},
    h('div', { class: 'section-label' }, 'Agents'),
    h('label', { class: 'row switch-row', for: 'agents' },
      h('span', { class: 'row-text' }, h('span', { class: 'row-title' }, 'Let Walnut agents use this browser'), h('span', { class: 'row-sub' }, st.on ? 'On' : 'Off')),
      box),
    note, err, await trustedRow())
  return wrap
}

/** Real mouse and keys for agents (the optional debugger permission); Chrome only, so hidden elsewhere. */
async function trustedRow(): Promise<HTMLElement | null> {
  const { available, on } = await trustedInputState()
  if (!available) return null
  const box = h('input', { type: 'checkbox', id: 'trusted', role: 'switch', 'data-testid': 'popup-trusted' }) as HTMLInputElement
  box.checked = on
  box.onclick = () => {
    // Asked inside the click: nothing is awaited before the browser's permission request.
    const want = box.checked
    void setTrustedInput(want).then((now) => { box.checked = now })
  }
  return h('div', { style: 'margin-top:8px' },
    h('label', { class: 'row switch-row', for: 'trusted' },
      h('span', { class: 'row-text' }, h('span', { class: 'row-title' }, 'Let agents use real mouse and keys')), box),
    h('p', { class: 'muted', style: 'margin:2px 4px 0;font-size:12px' }, 'For sites that ignore simulated input. Chrome shows a debugging bar while an agent uses it.'))
}

/** "Never for this site": each one listed, and taken off with its own button. */
async function neverSection(): Promise<HTMLElement> {
  const { neverSave } = await ext.storage.local.get('neverSave')
  const sites = Array.isArray(neverSave) ? (neverSave as string[]) : []
  const wrap = h('div', { 'data-testid': 'never-list' }, h('div', { class: 'section-label' }, 'Never offer to save on'))
  if (!sites.length) wrap.append(h('p', { class: 'muted', style: 'margin:0 4px;font-size:12px' }, 'No sites. "Never for this site" on the save bar adds one here.'))
  for (const site of sites) {
    const remove = h('button', { class: 'icon-btn', type: 'button', title: `Offer to save on ${site} again`, 'aria-label': `Remove ${site}`, 'data-testid': 'never-remove' }, icon('x'))
    remove.onclick = async () => {
      const now = (await ext.storage.local.get('neverSave')).neverSave as string[] | undefined
      await ext.storage.local.set({ neverSave: (now ?? []).filter((s) => s !== site) })
      wrap.replaceWith(await neverSection())
    }
    wrap.append(h('div', { class: 'never-row' }, icon('globe'), h('span', { class: 'row-title' }, site), remove))
  }
  return wrap
}

export async function settingsView(root: HTMLElement, st: { serverUrl?: string; device?: string }, back: () => void): Promise<void> {
  const settings = await getSettings()
  const off = h('button', { class: 'btn', type: 'button', 'data-testid': 'popup-disconnect' }, 'Disconnect this browser')
  off.onclick = async () => { await ask({ type: 'disconnect' }); back() }
  const lock = h('select', { class: 'select', id: 'autolock', 'aria-label': 'Lock Walnut', 'data-testid': 'popup-autolock' },
    ...AUTO_LOCKS.map((a) => h('option', { value: a.value }, a.label))) as HTMLSelectElement
  lock.value = settings.autoLock
  lock.onchange = () => void setSettings({ autoLock: lock.value as AutoLock })
  root.replaceChildren(h('div', {},
    topBar('Settings', back),
    h('div', { class: 'pane' },
      h('div', { class: 'section-label' }, 'Connected to'),
      h('div', { class: 'row' }, h('span', { class: 'logo' }, icon('key')),
        h('span', { class: 'row-text' }, h('span', { class: 'row-title' }, st.serverUrl ?? ''), h('span', { class: 'row-sub' }, st.device ?? ''))),
      h('div', { class: 'section-label' }, 'Lock'),
      h('div', { class: 'setting' }, h('span', { class: 'row-text' }, h('span', { class: 'row-title' }, 'Lock Walnut in this browser'),
        h('span', { class: 'row-sub' }, 'Also when the computer locks. Walnut itself locks after its own idle time too.')), lock),
      h('div', { class: 'section-label' }, 'Filling'),
      switchRow('copytotp', 'Copy the one-time code after filling', 'After a login with a code is filled, its code is on the clipboard for the next page.', settings.copyTotp,
        (on) => void setSettings({ copyTotp: on }), 'popup-copytotp'),
      await neverSection(),
      await agentSection(),
      h('div', { class: 'section-label' }, 'Fill shortcut'),
      h('p', { class: 'muted', style: 'margin:0 4px' }, 'Ctrl+Shift+L (⌘⇧L on a Mac) fills the login for the page, or opens the menu when there are several. In a field, the arrow keys open the menu and move through it.'),
      h('div', { style: 'height:16px' }), off)))
}
