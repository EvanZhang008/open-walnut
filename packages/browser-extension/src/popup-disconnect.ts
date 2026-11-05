/**
 * Settings' "Disconnect this browser", asked once more before it happens: it says what stops
 * (filling, saving, agents) until the browser is connected again, with Cancel beside it.
 */
import { ask } from './ext'
import { h } from './dom'
import { rememberServer } from './popup-connect'

export function disconnectControl(st: { serverUrl?: string }, back: () => void): HTMLElement {
  const wrap = h('div', { 'data-testid': 'popup-disconnect-wrap' })
  const ask1 = () => {
    const off = h('button', { class: 'btn btn-danger', type: 'button', 'data-testid': 'popup-disconnect' }, 'Disconnect this browser')
    off.onclick = confirm
    wrap.replaceChildren(off)
  }
  const confirm = () => {
    const yes = h('button', { class: 'btn btn-danger-solid', type: 'button', 'data-testid': 'popup-disconnect-confirm' }, 'Disconnect')
    yes.onclick = async () => {
      yes.disabled = true
      // Offered again on the connect view.
      if (st.serverUrl) rememberServer(st.serverUrl)
      await ask({ type: 'disconnect' })
      back()
    }
    const no = h('button', { class: 'btn', type: 'button', 'data-testid': 'popup-disconnect-cancel', onclick: ask1 }, 'Cancel')
    wrap.replaceChildren(h('div', { class: 'confirm-box', role: 'alertdialog', 'aria-labelledby': 'disc-title', 'aria-describedby': 'disc-text' },
      h('div', { class: 'row-title', id: 'disc-title' }, 'Disconnect this browser?'),
      h('p', { id: 'disc-text' }, 'Until you connect it again, Walnut stops filling and saving passwords here, and your Walnut agents can no longer use this browser. Your saved logins stay in Walnut.'),
      h('div', { class: 'confirm-actions' }, no, yes)))
    no.focus()
  }
  ask1()
  return wrap
}
