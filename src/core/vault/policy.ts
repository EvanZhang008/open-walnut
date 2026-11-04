/**
 * The person's agent settings, kept beside vault.json and sealed with the vault key (state.ts
 * side files), never in config.yaml: an agent can write config, and a switch it could flip
 * would be no switch.
 *
 *   agents          `allow` (shown "Any") | `ask` | `off`
 *   grantMs         how long an approved ask lets that task use that item: 0 (only that use),
 *                   3600000 (1 h), 43200000 (12 h), 172800000 (48 h, default), -1 (forever:
 *                   until the person revokes it)
 *
 * A vault with no policy file reads `ask` (48-hour grants): a vault set up before Any existed
 * keeps asking. A new vault's setup writes `allow` explicitly (writeNewVaultPolicy, from
 * store.ts setupVault), and the person picks either in Settings. A file that is there but does
 * not open (tampered with, sealed under another key) reads `ask`, never `allow`. A file deleted
 * while this server runs reads what this server last read, so removing it never loosens it.
 */
import fs from 'node:fs'
import path from 'node:path'
import { dir, openKey, openSide, updateSide } from './state.js'
import type { AgentsSwitch } from './agent.js'

const FILE = 'policy.json'

export const GRANT_ONCE = 0
export const GRANT_HOUR = 3_600_000
export const GRANT_12H = 43_200_000
export const GRANT_48H = 172_800_000
export const GRANT_UNTIL_REVOKED = -1
export const GRANT_CHOICES = [GRANT_ONCE, GRANT_HOUR, GRANT_12H, GRANT_48H, GRANT_UNTIL_REVOKED] as const
export const DEFAULT_GRANT_MS = GRANT_48H
/** A missing or unreadable policy. */
export const DEFAULT_AGENTS: AgentsSwitch = 'ask'
/** What a new vault's setup writes: Any. */
export const NEW_VAULT_AGENTS: AgentsSwitch = 'allow'

export interface Policy { agents: AgentsSwitch; grantMs: number }

const cleanAgents = (v: unknown): AgentsSwitch => (v === 'off' || v === 'allow' || v === 'ask' ? v : 'ask')
export const cleanGrantMs = (v: unknown): number => (GRANT_CHOICES as readonly number[]).includes(v as number) ? v as number : DEFAULT_GRANT_MS

function clean(p: Partial<Policy> | null | undefined): Policy {
  return { agents: cleanAgents(p?.agents), grantMs: cleanGrantMs(p?.grantMs) }
}

/** What this server last read, per vault (a vault set up anew never inherits another's). */
let lastKnown: { vaultId: string; policy: Policy } | null = null

/** Tests: forget what this process last read. */
export function resetPolicyForTest(): void {
  lastKnown = null
}

async function fileThere(): Promise<boolean> {
  const d = await dir()
  return fs.existsSync(path.join(d, FILE)) || fs.existsSync(path.join(d, `${FILE}.next`))
}

export async function readPolicy(): Promise<Policy> {
  const { vaultId } = await openKey()
  const p = await openSide<Partial<Policy>>(FILE)
  if (p) { const policy = clean(p); lastKnown = { vaultId, policy }; return policy }
  if (await fileThere()) return { agents: 'ask', grantMs: DEFAULT_GRANT_MS }
  if (lastKnown?.vaultId === vaultId) return lastKnown.policy
  return { agents: DEFAULT_AGENTS, grantMs: DEFAULT_GRANT_MS }
}

/** Change some settings; the rest stay as they are. */
export async function writePolicy(patch: Partial<Policy>): Promise<Policy> {
  const base = await readPolicy()
  const out = await updateSide<Policy>(FILE, (cur) => clean({ ...(cur ? clean(cur) : base), ...patch }))
  lastKnown = { vaultId: (await openKey()).vaultId, policy: out }
  return out
}

/** A vault just made: Any, 48-hour grants, written down so it never depends on a default. */
export async function writeNewVaultPolicy(): Promise<Policy> {
  return writePolicy({ agents: NEW_VAULT_AGENTS, grantMs: DEFAULT_GRANT_MS })
}
