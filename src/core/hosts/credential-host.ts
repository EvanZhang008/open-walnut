/**
 * The host a credential ask is about, as the person knows it.
 *
 * One machine can have several aliases in Settings that reach ONE daemon: an SSH row found in
 * ~/.ssh/config and the row the machine joined the host network as. A certificate letter is built
 * from the SSH rows, so without this it named the alias the person never picked (the found SSH
 * row) instead of the machine they use every day (its network row).
 *
 * Which aliases are one daemon comes only from the daemon's own word: the pair recorded in the
 * host profiles (`sameDaemon`, same-daemon-record.ts) when both links' hellos named one daemon
 * process, and only while each row still connects where it did then (linkIdentityOf). Never a
 * hostname or an address. Without such a pair the host is itself.
 *
 * This Mac's own key (`__local__`) is never a name a person reads: it is "your Mac" on macOS.
 */
import os from 'node:os'
import type { Config } from '../types.js'
import { hostDisplayName } from './host-display-name.js'
import { recordedSameDaemon } from './same-daemon-record.js'

export const LOCAL_HOST_ALIAS = '__local__'

type Row = NonNullable<Config['hosts']>[string] & { label?: unknown; enabled?: unknown; discovered?: unknown }

/** This machine's name in a sentence: "your Mac" on macOS, else "this computer". */
export function localHostLabel(platform: NodeJS.Platform = os.platform()): string {
  return platform === 'darwin' ? 'your Mac' : 'this computer'
}

/**
 * The aliases recorded as one daemon with `host`, `host` included, sorted. Each pair is checked
 * against the rows in `config` (both sides still connect where they did when it was recorded);
 * pairs are followed through, so A-B and B-C join C to A.
 */
export async function sameDaemonAliases(host: string, config: Config): Promise<string[]> {
  const seen = new Set<string>([host])
  const pending = [host]
  for (let i = 0; i < pending.length; i++) {
    for (const other of await recordedSameDaemon(pending[i], config)) {
      if (!seen.has(other)) { seen.add(other); pending.push(other) }
    }
  }
  return [...seen].sort()
}

/** The alias a person picked over the others: enabled, then one they added (not found), then labelled, then by name. */
function preferred(aliases: string[], rows: Record<string, Row | undefined>): string {
  const rank = (a: string) => {
    const r = rows[a]
    return [r?.enabled === false ? 1 : 0, r?.discovered === true ? 1 : 0, typeof r?.label === 'string' && r.label.trim() ? 0 : 1]
  }
  return [...aliases].sort((a, b) => {
    const x = rank(a), y = rank(b)
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i]
    return a < b ? -1 : a > b ? 1 : 0
  })[0]
}

/**
 * `host` as the person knows it: the alias they use for its daemon and that alias's name.
 * Two aliases of one daemon give the same answer, so a credential ask scoped by it is one ask.
 */
export async function credentialHost(host: string, config: Config): Promise<{ host: string; label: string }> {
  if (host === LOCAL_HOST_ALIAS) return { host, label: localHostLabel() }
  const rows = (config.hosts ?? {}) as Record<string, Row | undefined>
  const aliases = await sameDaemonAliases(host, config).catch(() => [host])
  const known = aliases.length > 1 ? preferred(aliases, rows) : host
  return { host: known, label: hostDisplayName(known, rows[known]?.label) }
}
