import crypto from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { alonePage, aloneContentSecurityPolicy } from './alone-page.js'

/**
 * Why a host server answers alone: it can reach neither the Mac nor the cloud
 * companion. The sentence names no task, session or file; the page that shows
 * more (alone-page.ts) asks for a device token first.
 */

const WHY: Record<string, string> = {
  'no-daemon': 'This host\'s Walnut daemon is not answering, so this server cannot tell who leads.',
  'mac-away': 'Your Mac is not answering (asleep, offline, or Walnut is restarting).',
  'nobody-answers': 'Neither your Mac nor your cloud companion is answering.',
  'draining': 'Your Mac is back and is taking in the changes made while it was away.',
}

export function aloneMessage(label: string, why: string): string {
  return `${WHY[why] ?? WHY['nobody-answers']} Sessions on ${label} keep running; this page opens Walnut again as soon as one answers.`
}

export function aloneJson(label: string, why: string): Record<string, unknown> {
  return { error: { code: 'leader_away', message: aloneMessage(label, why) }, why }
}

/** The alone answer: a 503 `leader_away` for the API, else the page of its own (alone-page.ts). */
export function sendAlone(req: IncomingMessage, res: ServerResponse, label: string, why: string): void {
  if (res.headersSent || res.destroyed) return
  if ((req.url ?? '').startsWith('/api/') || req.headers.accept?.includes('application/json')) {
    const text = JSON.stringify(aloneJson(label, why))
    res.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text) })
    res.end(text)
    return
  }
  // A working page of its own: this Walnut's sessions here, once the browser's token holds (alone-page.ts).
  const nonce = crypto.randomBytes(16).toString('base64')
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
    'content-security-policy': aloneContentSecurityPolicy(nonce), 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
  })
  res.end(alonePage(label, why, nonce))
}
