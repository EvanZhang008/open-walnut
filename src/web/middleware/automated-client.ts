/**
 * Puts a request from a browser under automation (`x-walnut-automated`, or a headless Chromium's
 * user agent) in the automated-client scope, so nothing it sends reads as the person's
 * (src/core/sessions/automated-client.ts). Decided once at boot: a throwaway server lets the
 * automation stand in for the person.
 */
import type { RequestHandler } from 'express'
import { automatedClientIsAgent, automatedClientOf, withAutomatedClient } from '../../core/sessions/automated-client.js'

export async function automatedClientMiddleware(): Promise<RequestHandler> {
  const on = await automatedClientIsAgent()
  return (req, res, next) => {
    // An event stream stays open for the page's life: work it starts lazily (a socket, a timer)
    // must not carry the scope that long. It sends nobody's words.
    const stream = String(req.headers.accept ?? '').includes('text/event-stream')
    const kind = on && !stream ? automatedClientOf(req.headers) : undefined
    if (!kind) { next(); return }
    // Only while the request is open: work it leaves armed (a timer) is not the request's.
    let open = true
    const end = () => { open = false }
    res.once('finish', end)
    res.once('close', end)
    withAutomatedClient(kind, () => next(), () => open)
  }
}
