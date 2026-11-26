/**
 * A page's logins read straight from Bitwarden, for an agent's browser fill_login and fill_code
 * while Walnut Passwords is locked (core/browser-control/fill-from-bitwarden.ts; 2026-11-26: two
 * tasks stopped to ask the person to unlock Passwords while the Bitwarden CLI, which agents may use,
 * was unlocked). The caller checked the person's opt-in first (agent-holds.ts).
 *
 * Walnut runs `bw list items --url <the page's origin and path>` itself (run.ts: BW_SESSION from the
 * server's environment or this Mac's keychain, a child process with a deadline), keeps the answer in
 * memory only, and matches each login to the page with Walnut's own rules (matchItem, the same
 * mapping of Bitwarden's websites as the sync). A login Bitwarden asks the master password again for
 * (its "reprompt") is never used, nor one the person keeps from agents in Walnut (Never or
 * sensitive: agent-holds.ts). Nothing here is logged or returned to an agent: the caller hands the
 * values to the extension alone.
 */
import { bw, bwSession } from './run.js'
import type { AgentHolds } from './agent-holds.js'

export interface PageLogin { id: string; title: string; username?: string; password?: string; totp?: string }

/** `kept`: logins for the page the person keeps from agents (Never, sensitive, Bitwarden's reprompt). */
export type PageLogins = { ok: true; logins: PageLogin[]; kept: number } | { ok: false; why: string }

const LIST_TIMEOUT_MS = 15_000

/** The page's logins; `holds` read by the caller (it checked the switches in them first). */
export async function bitwardenLoginsFor(page: string, holds: Extract<AgentHolds, { ok: true }>): Promise<PageLogins> {
  const session = await bwSession()
  if (!session) return { ok: false, why: 'the Bitwarden CLI has no session (BW_SESSION)' }
  // The page's origin and path only: its query string (a sign-in's state, a token) never reaches bw's command line.
  let asked = page
  try { const u = new URL(page); asked = `${u.origin}${u.pathname}` } catch { /* not a URL: matchItem refuses it below */ }
  const r = await bw(['list', 'items', '--url', asked], session, LIST_TIMEOUT_MS)
  if (!r.ok) return { ok: false, why: r.error }
  let items: unknown
  try { items = JSON.parse(r.stdout) } catch { return { ok: false, why: 'bw list items did not answer JSON' } }
  if (!Array.isArray(items)) return { ok: false, why: 'bw list items did not answer a list' }
  const { parseBitwardenExport } = await import('../../import.js')
  const { matchItem } = await import('../../url-match.js')
  const logins: PageLogin[] = []
  let kept = 0
  for (const e of parseBitwardenExport(JSON.stringify({ items }))) {
    const it = e.item
    if (!e.id || !it || it.type !== 'login' || !matchItem(it.urls, page)) continue
    if (it.sensitive || holds.held(e.id, it.urls, it.username)) { kept++; continue }
    logins.push({ id: e.id, title: it.title, ...(it.username ? { username: it.username } : {}), ...(it.password ? { password: it.password } : {}), ...(it.totp ? { totp: it.totp } : {}) })
  }
  return { ok: true, logins, kept }
}
