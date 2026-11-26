/**
 * `browser fill_login` / `fill_code` while Walnut Passwords is locked: the login comes from the
 * person's Bitwarden instead (vault/sources/bitwarden/page-logins.ts), and goes to the extension
 * alone, as from the vault (fill-login.ts sendFill); the agent never sees it (2026-11-26: tasks
 * asked the person to unlock Passwords to sign in while Bitwarden, the store agents use, was open).
 *
 * The same choices as the vault's: the login saved for the page (Walnut's match rules), one named
 * by id, name or username among several (`which_login` lists them), never one for another site.
 * It fills only when the vault itself would release the login with no ask (decideAgentUse, a
 * Bitwarden login read as access "ask", the default): agent access Allow, or approvals off. A use
 * Walnut would ask the person about needs Passwords unlocked to be approved, so it stays refused.
 * Nothing found, or Bitwarden not added or not unlocked: the vault's own `vault_locked` refusal,
 * saying why Bitwarden could not help. Known limit: an item the person set to "never" in Walnut
 * cannot be read while the vault is locked, so its Bitwarden twin is not held back by it. Walnut's
 * agent log is sealed with the vault key, so a fill from Bitwarden is in the task's actions only.
 */
import { BrowserError } from './hub.js'
import type { AgentsSwitch } from '../vault/agent.js'
import type { FillDeps, FillInput, FillOutcome } from './fill-login.js'

export async function fillFromBitwarden(input: FillInput & { what: 'login' | 'code' }, deps: FillDeps, url: string, agents: AgentsSwitch, locked: Error): Promise<{ outcome: FillOutcome; username?: string }> {
  const here = (() => { try { return new URL(url).host } catch { return url } })()
  const lockedBecause = (why: string) => new BrowserError(`${locked.message}. Bitwarden could not fill it either: ${why}.`, 423, 'vault_locked')
  const { decideAgentUse } = await import('../vault/agent.js')
  const { asksPerson } = await import('../approvals/ask-me.js')
  const fields = input.what === 'code' ? ['totp'] : ['username', 'password']
  if (decideAgentUse({ mode: agents, access: 'ask', sensitive: false, fields, use: 'fill', askMe: await asksPerson() }).kind !== 'release') {
    throw lockedBecause('Walnut asks the person before an agent uses a login, and that ask needs Passwords unlocked')
  }
  const { bitwardenLoginsFor } = await import('../vault/sources/bitwarden/page-logins.js')
  const r = await bitwardenLoginsFor(url)
  if (!r.ok) throw lockedBecause(r.why)
  const need = input.what === 'code' ? 'totp' : 'password'
  let logins = r.logins.filter((l) => !!l[need])
  const list = logins.slice(0, 20).map((l) => ({ id: l.id, title: l.title, ...(l.username ? { username: l.username } : {}) }))
  const named = (xs: typeof list) => xs.map((l) => `${l.id} "${l.title}"${l.username ? ` (${l.username})` : ''}`).join('; ')
  if (input.item) {
    const n = input.item.trim().toLowerCase()
    const byId = logins.filter((l) => l.id === input.item!.trim())
    logins = byId.length ? byId : logins.filter((l) => l.title.toLowerCase() === n || (l.username ?? '').toLowerCase() === n)
    if (!logins.length) throw lockedBecause(`no login "${input.item}" for ${here} in Bitwarden`)
  }
  if (!logins.length) throw lockedBecause(input.what === 'code' ? `no login for ${here} in Bitwarden has a one-time code` : `no login for ${here} in Bitwarden`)
  if (logins.length > 1) {
    const these = list.filter((l) => logins.some((x) => x.id === l.id))
    throw new BrowserError(`${logins.length} logins for ${here} in Bitwarden (Walnut Passwords is locked): say which with item (its id, name or username): ${named(these)}.`, 409, 'which_login', { logins: these, source: 'bitwarden' })
  }
  const l = logins[0]
  const { sendFill } = await import('./fill-login.js')
  const values: Record<string, string> = input.what === 'code' ? { totp: l.totp! } : { ...(l.username ? { username: l.username } : {}), password: l.password! }
  const outcome = await sendFill(deps, input.tab, url, { id: l.id, title: l.title }, values, input.what)
  return { outcome: { ...outcome, body: { ...outcome.body, source: 'bitwarden' } }, ...(l.username ? { username: l.username } : {}) }
}
