/**
 * The agent log: every time an agent asked for a password, got one, or was refused, kept in
 * `agent-log.json` beside vault.json and sealed with the vault key (state.ts side files), so
 * item names and purposes are as private as the vault. Newest LOG_MAX entries. It holds no
 * secret value. Written only while the vault is open; an entry made while it is closed is
 * dropped, because the only such entries are refusals that say "the vault is locked".
 */
import { isOpen, openSide, updateSide } from './state.js'

export const LOG_MAX = 500
const FILE = 'agent-log.json'

/**
 * `fill`: a login Walnut put into a browser page for an agent (browser fill_login), the agent never seeing it.
 * `listed`: an agent read the list of items it may ask for. `revoked`: the person ended a grant.
 * `synced`: a Bitwarden sync changed the vault (counts only).
 */
export type AgentLogKind = 'released' | 'fill' | 'asked' | 'denied' | 'refused' | 'expired' | 'listed' | 'revoked' | 'synced'

/**
 * How the value was used: `reveal` (the plaintext went back to the agent), `env` (into a
 * command's environment, `walnut pass run`), `fill` (into a browser page), `list` (no value).
 */
export type AgentUseKind = 'reveal' | 'env' | 'fill' | 'list'

export interface AgentLogEntry {
  at: string
  kind: AgentLogKind
  itemId?: string
  itemTitle?: string
  fields?: string[]
  purpose?: string
  /** How a release was allowed: the item allows agents, a grant for this task, a person's approval. */
  via?: 'allow' | 'grant' | 'approval' | 'approvals-off'
  /** A refusal's code (agent_never, agents_off, agent_paused, ...). */
  reason?: string
  approvalId?: string
  /** Who asked. */
  taskId?: string
  taskTitle?: string
  sessionId?: string
  host?: string
  command?: string
  use?: AgentUseKind
  /** Who approved it (the device, with Face ID or Touch ID when it signed). */
  approvedBy?: string
  /** A listing: how many items it showed. A sync: what it changed. */
  count?: number
  summary?: string
}

export async function appendAgentLog(entry: Omit<AgentLogEntry, 'at'>): Promise<void> {
  if (!isOpen()) return
  await updateSide<AgentLogEntry[]>(FILE, (cur) => [...(cur ?? []), { at: new Date().toISOString(), ...entry }].slice(-LOG_MAX))
    .catch(() => undefined)
}

/** Newest first. */
export async function readAgentLog(limit = 200): Promise<AgentLogEntry[]> {
  const all = (await openSide<AgentLogEntry[]>(FILE)) ?? []
  return all.reverse().slice(0, limit)
}
