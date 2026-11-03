/**
 * The person's switch for agents (`off` | `ask` | `allow`), kept beside vault.json and sealed
 * with the vault key (state.ts side files), never in config.yaml: an agent can write config,
 * and a switch it could flip to `allow` would be no switch. A missing or unreadable file reads
 * `ask`, the safe middle.
 */
import { openSide, updateSide } from './state.js'
import type { AgentsSwitch } from './agent.js'

const FILE = 'policy.json'
export interface Policy { agents: AgentsSwitch }

const clean = (v: unknown): AgentsSwitch => (v === 'off' || v === 'allow' ? v : 'ask')

export async function readPolicy(): Promise<Policy> {
  const p = await openSide<Policy>(FILE)
  return { agents: clean(p?.agents) }
}

export async function writePolicy(p: Policy): Promise<Policy> {
  return updateSide<Policy>(FILE, () => ({ agents: clean(p.agents) }))
}
