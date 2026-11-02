/**
 * The ticket of an invite made with no cloud companion (core/net/net-local.ts): what a
 * new machine needs to reach the Mac and be taken in, in one word it can paste.
 *
 *   wn1-<base64url of {"v":1,"m":<Mac id>,"c":<code>,"r":"public"|"none","a":[ip:port],"u":<relay>}>
 *
 * It holds no secret beyond the one-use code (10 minutes); the Mac's id is its public key.
 */
export const TICKET_PREFIX = 'wn1-'
export const JOIN_SCRIPT_URL = 'https://github.com/EvanZhang008/open-walnut/releases/latest/download/join.sh'

export interface JoinTicket {
  mac: string
  code: string
  relayMode: 'public' | 'none'
  addrs: string[]
  relay: string | null
}

const ID_RE = /^[0-9a-f]{64}$/
const CODE_RE = /^[A-HJ-NP-Z2-9]{4}-?[A-HJ-NP-Z2-9]{4}-?[A-HJ-NP-Z2-9]{4}$/
const ADDR_RE = /^(?:\[[0-9a-fA-F:.]+\]|\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/

export function encodeTicket(t: JoinTicket): string {
  const body: Record<string, unknown> = { v: 1, m: t.mac, c: t.code, r: t.relayMode }
  if (t.addrs.length) body.a = t.addrs.slice(0, 8)
  if (t.relay) body.u = t.relay
  return TICKET_PREFIX + Buffer.from(JSON.stringify(body)).toString('base64url')
}

/** The ticket in `s`, or null when it is not one this version reads. */
export function decodeTicket(s: unknown): JoinTicket | null {
  if (typeof s !== 'string' || !s.startsWith(TICKET_PREFIX) || s.length > 2048) return null
  let o: Record<string, unknown>
  try { o = JSON.parse(Buffer.from(s.slice(TICKET_PREFIX.length), 'base64url').toString('utf8')) as Record<string, unknown> } catch { return null }
  if (!o || o.v !== 1 || typeof o.m !== 'string' || !ID_RE.test(o.m) || typeof o.c !== 'string' || !CODE_RE.test(o.c)) return null
  if (o.r !== 'public' && o.r !== 'none') return null
  const addrs = Array.isArray(o.a) ? o.a.filter((a): a is string => typeof a === 'string' && ADDR_RE.test(a)).slice(0, 8) : []
  const relay = typeof o.u === 'string' && /^https:\/\/\S{1,500}$/.test(o.u) ? o.u : null
  return { mac: o.m, code: o.c, relayMode: o.r, addrs, relay }
}

/** The command Settings shows for a ticket. */
export function ticketCommand(ticket: string): string {
  return `curl -fsSL ${JOIN_SCRIPT_URL} | sh -s -- ${ticket}`
}
