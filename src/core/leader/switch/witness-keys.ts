/**
 * The witnesses' own keys (docs/reference/leader-switch.md, "Witness keys"). A witness kept by a
 * machine gets a key once, when it is set up (`walnut leader witnesses init`): 32 random bytes,
 * written to `leader_switch.witnesses[].key` in config.yaml (leader data, sensitive: it travels
 * with the standby copy, so a candidate that holds a full copy holds every key) and, by the
 * witness's setup, beside its record on its machine (witness-route.ts setUpMachineWitness). It is
 * never a host credential, and never borrowed by one.
 *
 * Where a key may be, and nowhere else (tests/core/leader/switch/witness-key-ratchet.test.ts):
 * config.yaml (masked in every client view: config-redact.ts maskLeaderSwitchKeys; dropped whole from
 * a host's config copy: replication/config-allowlist.ts), the witness's key file, a setup body over an
 * authenticated link, and the HMAC it keys. Never a log line, an error message or an API answer.
 */
import path from 'node:path'
import { proofSecret } from '../../../utils/hmac-proof.js'
import { readHomeConfigRaw } from './settings.js'

/**
 * Mint a key for every witness kept by a machine that has none, and write them to `home`'s
 * config.yaml (through the config manager: the leader's server sees the change). Returns the ids
 * keyed now. A key that is there is never replaced (a witness keeps its key for its life).
 */
export async function mintWitnessKeys(home: string): Promise<string[]> {
  const raw = readHomeConfigRaw(home).leader_switch as { witnesses?: unknown } | undefined
  const witnesses = Array.isArray(raw?.witnesses) ? raw!.witnesses as Record<string, unknown>[] : []
  const minted: string[] = []
  const next = witnesses.map((w) => {
    if (!w || typeof w !== 'object' || typeof w.dir === 'string' || typeof w.key === 'string' || typeof w.id !== 'string') return w
    minted.push(w.id)
    return { ...w, key: proofSecret() }
  })
  if (!minted.length) return []
  const [{ WALNUT_HOME }, { updateConfig }] = await Promise.all([import('../../../constants.js'), import('../../config-manager.js')])
  if (path.resolve(WALNUT_HOME) !== path.resolve(home)) throw new Error(`the keys are written to this Walnut's own config.yaml: run this with OPEN_WALNUT_HOME=${home}`)
  await updateConfig({ leader_switch: { witnesses: next as NonNullable<import('../../types.js').Config['leader_switch']>['witnesses'] } })
  return minted
}
