/**
 * What a client tells the model about the thing a person asks about (a web page in the browser
 * side panel, a mail, the tab they let an ask act in), kept here for the `object-context` message
 * hint. 2026-11-04, the user: "the instruction to walnut should be ... some automatic thing", not
 * his words. The web composed it into the person's message before, so it read as his and
 * `sentBy: "person"` carried it.
 *
 * The client stores the text (POST /api/v1/hints/context) and asks for the hint by its id on the
 * send that should carry it (`hints: { "object-context": "<id>" }`), and the registry renders it
 * as a Walnut block beside the person's words. The store lives in memory and keeps an id for a
 * day: a send follows its store within seconds, and a restart in between loses only the context,
 * never the message.
 */
import crypto from 'node:crypto'

export interface HintContext { name: string; text: string; at: number }

export const HINT_CONTEXT_MAX = 40_000
const NAME_MAX = 60
const KEEP_MS = 24 * 3600_000
const KEEP_MAX = 500
export const HINT_CONTEXT_ID = /^hc-[0-9a-f]{16}$/

const contexts = new Map<string, HintContext>()

function prune(now: number): void {
  for (const [id, c] of contexts) if (now - c.at > KEEP_MS) contexts.delete(id)
  while (contexts.size > KEEP_MAX) contexts.delete(contexts.keys().next().value as string)
}

/** The context from a request body, or null when it is not one. */
export function cleanHintContext(raw: unknown): { name: string; text: string } | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const text = typeof r.text === 'string' ? r.text.trim().slice(0, HINT_CONTEXT_MAX) : ''
  if (!text) return null
  const name = (typeof r.name === 'string' ? r.name : '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX) || 'Context'
  return { name, text }
}

export function putHintContext(c: { name: string; text: string }, now = Date.now()): string {
  prune(now)
  const id = `hc-${crypto.randomBytes(8).toString('hex')}`
  contexts.set(id, { name: c.name, text: c.text, at: now })
  return id
}

export function getHintContext(id: string | undefined, now = Date.now()): HintContext | null {
  if (!id || !HINT_CONTEXT_ID.test(id)) return null
  const c = contexts.get(id)
  if (!c || now - c.at > KEEP_MS) return null
  return c
}

/** The hint's words: what the thing is, then what the client said about it. */
export function hintContextText(c: Pick<HintContext, 'name' | 'text'>): string {
  return `${c.name} (Walnut added this for the person's message; it is context, not their words):\n${c.text}`
}
