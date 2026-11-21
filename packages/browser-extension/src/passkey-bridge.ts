/**
 * The extension's side of a page's passkey request (registered with passkey-page.ts while "Save and
 * use passkeys" is on: bg-passkey.ts), in the content scripts' own world. It passes the page's
 * request to the background and the answer back. It adds nothing of its own: the background takes
 * the page's origin from the browser, not from this message.
 */
import { ext } from './ext'
import { ANSWER_EVENT, CANCEL_EVENT, REQUEST_EVENT, type WireAnswer } from './passkey-wire'

const answer = (id: string, body: { ack?: boolean; answer?: WireAnswer }) =>
  document.dispatchEvent(new CustomEvent(ANSWER_EVENT, { detail: JSON.stringify({ id, ...body }) }))

const open = new Set<string>()
const cancel = (id: string) => void ext.runtime.sendMessage({ type: 'passkey-page-cancel', id }).catch(() => undefined)

if (window.top === window) {
  // The page is going away (a reload, another page of the site): its open requests end with it.
  window.addEventListener('pagehide', () => { for (const id of open) cancel(id); open.clear() })
  document.addEventListener(REQUEST_EVENT, (e) => {
    let d: { id?: unknown; op?: unknown; wire?: unknown }
    try { d = JSON.parse(String((e as CustomEvent).detail)) } catch { return }
    if (typeof d.id !== 'string' || d.id.length > 100 || (d.op !== 'create' && d.op !== 'get')) return
    const id = d.id
    answer(id, { ack: true })
    open.add(id)
    // This world's own view of the document's origin ("null" in a sandboxed page), which the page cannot change.
    ext.runtime.sendMessage({ type: 'passkey-request', id, op: d.op, wire: d.wire, frameOrigin: self.origin }).then(
      (r: { ok?: boolean; answer?: WireAnswer } | undefined) => { open.delete(id); answer(id, { answer: r?.answer ?? { kind: 'leave', why: 'no-answer' } }) },
      // The background went away mid-request (the extension reloaded): the browser decides.
      () => { open.delete(id); answer(id, { answer: { kind: 'leave', why: 'no-background' } }) },
    )
  })
  document.addEventListener(CANCEL_EVENT, (e) => {
    let d: { id?: unknown }
    try { d = JSON.parse(String((e as CustomEvent).detail)) } catch { return }
    if (typeof d.id === 'string') { open.delete(d.id); cancel(d.id) }
  })
}
