/**
 * `browser fill_login` / `fill_code` while Walnut Passwords is locked: the login comes from the
 * person's Bitwarden instead (vault/sources/bitwarden/page-logins.ts), and goes to the extension
 * alone, as from the vault (fill-login.ts sendFill); the agent never sees it (2026-11-26: tasks
 * asked the person to unlock Passwords to sign in while Bitwarden, the store agents use, was open).
 *
 * Only when the person turned it on (Settings, Passwords, Agents: "Sign in with Bitwarden while
 * locked"), and with every guard of the vault's own fill that can hold while locked
 * (vault/sources/bitwarden/agent-holds.ts carries what the sealed vault cannot show):
 *   - the agents switch as it was when Passwords was last open; Off, or a use Walnut would ask the
 *     person about (a Bitwarden login reads as access "ask"), refuses: that ask needs Passwords open;
 *   - a login the person set to Never or marked sensitive in Walnut, or a Bitwarden reprompt, is
 *     never filled; holds never noted, or stale since vault.json changed, refuse every fill;
 *   - Lock all stops it until Passwords is unlocked again, and Lock all or a move of the switch
 *     while bw runs withdraws the fill (the agent epoch);
 *   - the per-task brake of the vault's releases (RELEASE_MAX), and with approvals off the use is
 *     listed under Approvals (recordUnasked), as the vault's own is.
 * The same choices as the vault's: the login saved for the page (Walnut's match rules), one named
 * by id, name or username among several (`which_login` lists them), never one for another site.
 * Walnut's agent log is sealed with the vault key, so a fill from Bitwarden is in the task's
 * actions and under Approvals only.
 */
import { BrowserError } from './hub.js'
import type { FillDeps, FillInput, FillOutcome } from './fill-login.js'

export async function fillFromBitwarden(input: FillInput & { what: 'login' | 'code' }, deps: FillDeps, url: string, locked: Error): Promise<{ outcome: FillOutcome; username?: string }> {
  const here = (() => { try { return new URL(url).host } catch { return url } })()
  const lockedBecause = (why: string) => new BrowserError(`${locked.message}. Bitwarden could not fill it either: ${why}.`, 423, 'vault_locked')
  const { readAgentHolds } = await import('../vault/sources/bitwarden/agent-holds.js')
  const holds = await readAgentHolds()
  if (!holds.ok) throw lockedBecause(holds.why)
  if (!holds.bitwarden) throw lockedBecause('signing in with Bitwarden while locked is off (Settings, Passwords, Agents)')
  const { agentEpoch, decideAgentUse, takeOutsideRelease } = await import('../vault/agent.js')
  const { asksPerson } = await import('../approvals/ask-me.js')
  const since = agentEpoch()
  const fields = input.what === 'code' ? ['totp'] : ['username', 'password']
  const decision = decideAgentUse({ mode: holds.agents, access: 'ask', sensitive: false, fields, use: 'fill', askMe: await asksPerson() })
  if (decision.kind !== 'release') throw lockedBecause('Walnut asks the person before an agent uses a login, and that ask needs Passwords unlocked')
  const { bitwardenLoginsFor } = await import('../vault/sources/bitwarden/page-logins.js')
  const r = await bitwardenLoginsFor(url, holds)
  if (!r.ok) throw lockedBecause(r.why)
  const need = input.what === 'code' ? 'totp' : 'password'
  let logins = r.logins.filter((l) => !!l[need])
  const list = logins.slice(0, 20).map((l) => ({ id: l.id, title: l.title, ...(l.username ? { username: l.username } : {}) }))
  const named = (xs: typeof list) => xs.map((l) => `${l.id} "${l.title}"${l.username ? ` (${l.username})` : ''}`).join('; ')
  const kept = r.kept ? ` (${r.kept} more you keep from agents)` : ''
  if (input.item) {
    const n = input.item.trim().toLowerCase()
    const byId = logins.filter((l) => l.id === input.item!.trim())
    logins = byId.length ? byId : logins.filter((l) => l.title.toLowerCase() === n || (l.username ?? '').toLowerCase() === n)
    if (!logins.length) throw lockedBecause(`no login "${input.item}" for ${here} in Bitwarden that agents may use${kept}`)
  }
  if (!logins.length) throw lockedBecause(input.what === 'code' ? `no login for ${here} in Bitwarden has a one-time code agents may use${kept}` : `no login for ${here} in Bitwarden that agents may use${kept}`)
  if (logins.length > 1) {
    const these = list.filter((l) => logins.some((x) => x.id === l.id))
    throw new BrowserError(`${logins.length} logins for ${here} in Bitwarden (Walnut Passwords is locked): say which with item (its id, name or username): ${named(these)}.`, 409, 'which_login', { logins: these, source: 'bitwarden' })
  }
  // Lock all, or the switch moved, while bw ran: nothing is filled.
  const now = await readAgentHolds()
  if (since !== agentEpoch() || !now.ok || !now.bitwarden || now.agents !== holds.agents) throw lockedBecause('agent access changed while this ran (Lock all, or the switch moved)')
  takeOutsideRelease(input.requester)
  const l = logins[0]
  const { sendFill } = await import('./fill-login.js')
  const values: Record<string, string> = input.what === 'code' ? { totp: l.totp! } : { ...(l.username ? { username: l.username } : {}), password: l.password! }
  const outcome = await sendFill(deps, input.tab, url, { id: l.id, title: l.title }, values, input.what)
  if (decision.via === 'approvals-off') {
    const { recordUnasked } = await import('../approvals/ask-me.js')
    const r2 = input.requester
    await recordUnasked('vaultUse', {
      what: `Filled the Bitwarden login “${l.title}” on ${here} for ${r2.taskTitle ? `“${r2.taskTitle}”` : 'an agent'} (Passwords was locked)`,
      requester: { host: r2.host, ...(r2.taskId ? { taskId: r2.taskId } : {}), ...(r2.taskTitle ? { taskTitle: r2.taskTitle } : {}) },
    })
  }
  return { outcome: { ...outcome, body: { ...outcome.body, source: 'bitwarden' } }, ...(l.username ? { username: l.username } : {}) }
}
