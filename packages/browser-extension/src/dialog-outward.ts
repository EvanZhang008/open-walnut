/**
 * Accepting a page's confirm or prompt is the step it asks about: "Delete this project?" OK deletes
 * it, "Place your order for $42?" OK buys. So an agent's accept is judged by the dialog's words with
 * the same rules as a click (page-agent-outward.ts), and one that buys, sends or deletes waits for
 * the person's yes (routes/browser-v1.ts asks). An alert has only OK, and Cancel never acts: neither
 * is judged. Here in the background, apart from any page: the page is held by its dialog.
 */
import { judgeOutward, type Outward, type OutwardKind } from './page-agent-outward'

export interface DialogHold { kind: OutwardKind; why: string; what: string; url: string; sig: string; message?: string }

const clip = (t: string, n: number) => { const x = t.replace(/\s+/g, ' ').trim(); return x.length > n ? `${x.slice(0, n - 1)}…` : x }

/** The first sentence of the message that buys, sends or deletes (the judge reads 80 characters at a time). */
function judgeWords(message: string): Outward | null {
  const parts = message.split(/(?<=[.!?:;])\s+|\n+/).map((p) => p.trim()).filter(Boolean).slice(0, 30)
  for (const p of parts.length ? parts : [message]) {
    const o = judgeOutward({ name: p })
    if (o) return o
  }
  return null
}

/**
 * The hold an accept of this dialog waits on, or null when it may go ahead. The signature names the
 * dialog, the page and a prompt's text, so a yes for one answer does not give another.
 */
export function dialogOutward(d: { type: string; message: string }, accept: boolean, text: string | undefined, pageUrl: string): DialogHold | null {
  if (!accept || (d.type !== 'confirm' && d.type !== 'prompt')) return null
  const o = judgeWords(d.message)
  if (!o) return null
  const what = `accept the ${d.type} "${clip(d.message, 80)}"`
  let at = ''
  try { const u = new URL(pageUrl); at = `${u.origin}${u.pathname}` } catch { at = pageUrl }
  const message = o.kind === 'send' && text?.trim() ? clip(text, 300) : undefined
  return {
    kind: o.kind, why: o.why, what, url: pageUrl.split('#')[0], ...(message ? { message } : {}),
    sig: `${o.kind}|${what}|${at}|${text ?? ''}|`.slice(0, 400),
  }
}
