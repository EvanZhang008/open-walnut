/**
 * The person's own "keep this from agents" marks, kept readable for while Walnut Passwords is
 * locked, so an agent's sign-in from Bitwarden (fill-from-bitwarden.ts) honours them too. A login
 * set to Never or marked sensitive in Walnut is sealed in vault.json, out of reach while locked; its
 * Bitwarden twin would otherwise be filled (2026-11-26 review of the Bitwarden fill).
 *
 * `bitwarden-agent-holds.json` beside vault.json holds no name, site or username: the Bitwarden ids
 * linked (by the sync) to a Walnut item that is Never, sensitive, trashed or gone, and a hash of
 * each such item's site (registrable domain) and username salted with the vault id (no secret: it
 * hides the names from a glance, not from a guess), which catches a twin the sync never linked. It
 * is written while the vault is open, after every write of vault.json and every open
 * (onVaultSaved), and records a hash of vault.json's and policy.json's contents: either changed
 * since (a write it missed, a switch moved, a backup put back) makes it stale, and a stale, missing or unreadable file refuses every Bitwarden
 * fill until Passwords is opened again. Lock all writes `stopped` into it: no Bitwarden fill until
 * the person unlocks again (Walnut's own opens from the keychain keep it). It also carries the two switches the fill obeys, sealed in
 * policy.json and so unreadable while locked: the agents switch, and the person's own opt-in
 * (`bitwardenWhileLocked`, Settings, Passwords, Agents); a change of either writes it at once.
 *
 * The file is plain: it keeps a well-behaved agent to the person's marks, it is no lock against a
 * program running as the person (one could run bw itself). The switches stay sealed, written only
 * through the person's own route, so no API call of an agent turns this on.
 */
import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { siteKey } from '../../url-match.js'
import type { AgentsSwitch } from '../../agent.js'
import { dir, onVaultSaved, openSide, readJson, requireOpen, VaultError, writeAtomic } from '../../state.js'

const NAME = 'bitwarden-agent-holds.json'
const SYNC_FILE = 'bitwarden-sync.json'

interface HoldsFile {
  version: 1
  vaultId?: string
  /** When the vault was last seen open and this was written. */
  at?: string
  /** sourceHash() when written: any other value now makes the file stale. */
  source?: string
  /** Lock all, since `at`: no Bitwarden fill until Passwords opens again. */
  stopped?: string
  /** The agents switch and the person's opt-in, as policy.json said when written. */
  agents?: AgentsSwitch
  bitwarden?: boolean
  ids?: string[]
  pairs?: string[]
}

interface SyncLinks { links?: Record<string, { itemId: string }> }

export type AgentHolds = { ok: true; vaultId: string; agents: AgentsSwitch; bitwarden: boolean; held: (bwId: string, urls: string[] | undefined, username: string | undefined) => boolean } | { ok: false; why: string }

const file = async () => path.join(await dir(), NAME)
/** What the holds were noted from: vault.json and policy.json (with a rekey's .next copy) by content, never by mtime. */
async function sourceHash(): Promise<string> {
  const d = await dir()
  const h = crypto.createHash('sha256')
  for (const name of ['vault.json', 'policy.json', 'policy.json.next']) {
    const body = await fsp.readFile(path.join(d, name)).catch((err: NodeJS.ErrnoException) => { if (err.code === 'ENOENT') return null; throw err })
    h.update(`${name}\n${body ? body.length : -1}\n`)
    if (body) h.update(body)
  }
  return h.digest('hex')
}

function pairKey(vaultId: string, url: string, username: string | undefined): string | null {
  const domain = siteKey(url)?.domain
  if (!domain) return null
  return crypto.createHash('sha256').update(`${vaultId}\n${domain}\n${(username ?? '').trim().toLowerCase()}`).digest('hex').slice(0, 32)
}

/**
 * Write the holds from the open vault. Needs the vault open; skips when vault.json or policy.json
 * changed meanwhile (the next write's call writes it). Lock all's `stopped` stays: only the
 * person's own unlock (`clearStop`, routes/vault-v1.ts) ends it, never Walnut's own open from the
 * keychain (the daily Bitwarden sync, the unlock at start).
 */
export async function writeAgentHolds(opts: { clearStop?: boolean } = {}): Promise<boolean> {
  const before = await sourceHash()
  const { f, items } = await requireOpen()
  const sync = (await openSide<SyncLinks>(SYNC_FILE)) ?? {}
  const held = (id: string) => { const it = items.get(id); return !it || !!it.trashedAt || it.agentAccess === 'never' || !!it.sensitive }
  const ids = Object.entries(sync.links ?? {}).filter(([, l]) => held(l.itemId)).map(([bwId]) => bwId).sort()
  const pairs = new Set<string>()
  for (const it of items.values()) {
    if (it.type !== 'login' || !(it.agentAccess === 'never' || it.sensitive)) continue
    for (const u of it.urls ?? []) { const k = pairKey(f.id, u, it.username); if (k) pairs.add(k) }
  }
  const { readPolicy } = await import('../../policy.js')
  const policy = await readPolicy()
  if (await sourceHash() !== before) return false
  const cur = opts.clearStop ? null : await readJson<HoldsFile>(await file()).catch(() => null)
  await writeAtomic(await file(), {
    version: 1, vaultId: f.id, at: new Date().toISOString(), source: before, agents: policy.agents, bitwarden: policy.bitwardenWhileLocked,
    ...(cur?.stopped ? { stopped: cur.stopped } : {}), ids, pairs: [...pairs].sort(),
  } satisfies HoldsFile)
  return true
}

/** Write the holds now, in line with the debounced writes (a policy change, the person's unlock). A failed write leaves them stale, which refuses. */
export function refreshAgentHolds(opts: { clearStop?: boolean } = {}): Promise<unknown> {
  if (timer) { clearTimeout(timer); timer = null }
  writing = writing.catch(() => undefined).then(() => writeAgentHolds(opts))
  return writing.catch(() => undefined)
}

/** The holds as they stand, for a Bitwarden fill while the vault is locked. */
export async function readAgentHolds(): Promise<AgentHolds> {
  const unlockOnce = 'Walnut has not noted since the last change which logins you keep from agents; it does the next time Passwords is unlocked'
  let h: HoldsFile | null
  try { h = await readJson<HoldsFile>(await file()) } catch { return { ok: false, why: unlockOnce } }
  if (h?.stopped) return { ok: false, why: 'Lock all stopped agent sign-ins until Passwords is unlocked again' }
  if (!h || h.version !== 1 || !h.vaultId || typeof h.source !== 'string') return { ok: false, why: unlockOnce }
  let now: string
  try { now = await sourceHash() } catch { return { ok: false, why: unlockOnce } }
  if (now !== h.source) return { ok: false, why: unlockOnce }
  const ids = new Set(h.ids ?? [])
  const pairs = new Set(h.pairs ?? [])
  const vaultId = h.vaultId
  return {
    ok: true, vaultId, agents: h.agents === 'allow' || h.agents === 'off' ? h.agents : 'ask', bitwarden: h.bitwarden === true,
    held: (bwId, urls, username) => ids.has(bwId) || (urls ?? []).some((u) => { const k = pairKey(vaultId, u, username); return !!k && pairs.has(k) }),
  }
}

/** Lock all: no Bitwarden fill until Passwords opens again. A write still due is dropped first. */
export async function stopAgentHolds(): Promise<void> {
  if (timer) { clearTimeout(timer); timer = null }
  await writing.catch(() => undefined)
  const cur = await readJson<HoldsFile>(await file()).catch(() => null)
  await writeAtomic(await file(), { ...(cur ?? {}), version: 1, stopped: new Date().toISOString() } satisfies HoldsFile)
}

/** The Walnut item a Bitwarden id is linked to (a `which_login` id given back once Passwords is open). Needs the vault open. */
export async function walnutIdOfBitwarden(bwId: string): Promise<string | null> {
  const sync = (await openSide<SyncLinks>(SYNC_FILE)) ?? {}
  return sync.links?.[bwId.trim()]?.itemId ?? null
}

// After a vault write or open, once mutate took the new items into memory, the holds follow. A burst is one write.
let timer: ReturnType<typeof setTimeout> | null = null
let writing: Promise<unknown> = Promise.resolve()
const DELAY_MS = 300

function schedule(): void {
  if (timer) return
  timer = setTimeout(() => {
    timer = null
    writing = writing.then(() => writeAgentHolds()).catch((err: unknown) => {
      // Closed meanwhile: the file stays stale and refuses, which is the safe side.
      if (!(err instanceof VaultError && err.code === 'vault_locked')) void import('../../../../logging/index.js').then(({ log }) => log.web.warn('bitwarden agent holds not written', { error: err instanceof Error ? err.message : String(err) })).catch(() => undefined)
    })
  }, DELAY_MS)
  timer.unref?.()
}

onVaultSaved(schedule)

/** Wait for a write that is due (tests). */
export async function settleAgentHolds(): Promise<void> {
  if (timer) { clearTimeout(timer); timer = null; writing = writing.then(() => writeAgentHolds()) }
  await writing.catch(() => undefined)
}
