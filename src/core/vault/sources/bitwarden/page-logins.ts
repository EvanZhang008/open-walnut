/**
 * A page's logins read straight from Bitwarden, for an agent's browser fill_login and fill_code
 * while Walnut Passwords is locked (core/browser-control/fill-from-bitwarden.ts; 2026-11-26: two
 * tasks stopped to ask the person to unlock Passwords while the Bitwarden CLI, which agents may use,
 * was unlocked).
 *
 * Only for a person who added Bitwarden as a source (Settings, Passwords: `sourceAdded`). Walnut runs
 * `bw list items --url <page>` itself (run.ts: BW_SESSION from the server's environment or this
 * Mac's keychain, a child process with a deadline), keeps the answer in memory only, and matches
 * each login to the page with Walnut's own rules (matchItem, the same mapping of Bitwarden's
 * websites as the sync). A login Bitwarden asks the master password again for (its "reprompt") is
 * never used. Nothing here is logged or returned to an agent: the caller hands the values to the
 * extension alone.
 */
import { bw, bwSession } from './run.js'

export interface PageLogin { id: string; title: string; username?: string; password?: string; totp?: string }

export type PageLogins = { ok: true; logins: PageLogin[] } | { ok: false; why: string }

const LIST_TIMEOUT_MS = 30_000

export async function bitwardenLoginsFor(page: string): Promise<PageLogins> {
  const { getConfig } = await import('../../../config-manager.js')
  const { sourceAdded } = await import('../index.js')
  if (!sourceAdded((await getConfig()).passwords, 'bitwarden')) return { ok: false, why: 'Bitwarden is not one of the password sources in Settings' }
  const session = await bwSession()
  if (!session) return { ok: false, why: 'the Bitwarden CLI has no session (BW_SESSION)' }
  const r = await bw(['list', 'items', '--url', page], session, LIST_TIMEOUT_MS)
  if (!r.ok) return { ok: false, why: r.error }
  let items: unknown
  try { items = JSON.parse(r.stdout) } catch { return { ok: false, why: 'bw list items did not answer JSON' } }
  if (!Array.isArray(items)) return { ok: false, why: 'bw list items did not answer a list' }
  const { parseBitwardenExport } = await import('../../import.js')
  const { matchItem } = await import('../../url-match.js')
  const logins: PageLogin[] = []
  for (const e of parseBitwardenExport(JSON.stringify({ items }))) {
    const it = e.item
    if (!e.id || !it || it.type !== 'login' || it.sensitive || !matchItem(it.urls, page)) continue
    logins.push({ id: e.id, title: it.title, ...(it.username ? { username: it.username } : {}), ...(it.password ? { password: it.password } : {}), ...(it.totp ? { totp: it.totp } : {}) })
  }
  return { ok: true, logins }
}
