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
import { LOCAL_HOST_ALIAS, preferredAlias, sameDaemonAliases } from './daemon-twins.js'

export { LOCAL_HOST_ALIAS, sameDaemonAliases }

type Row = NonNullable<Config['hosts']>[string] & { label?: unknown; enabled?: unknown; discovered?: unknown }

/** This machine's name in a sentence: "your Mac" on macOS, else "this computer". */
export function localHostLabel(platform: NodeJS.Platform = os.platform()): string {
  return platform === 'darwin' ? 'your Mac' : 'this computer'
}

/**
 * `host` as the person knows it: the alias they use for its daemon and that alias's name.
 * Two aliases of one daemon give the same answer, so a credential ask scoped by it is one ask.
 */
export async function credentialHost(host: string, config: Config): Promise<{ host: string; label: string }> {
  if (host === LOCAL_HOST_ALIAS) return { host, label: localHostLabel() }
  const rows = (config.hosts ?? {}) as Record<string, Row | undefined>
  const aliases = await sameDaemonAliases(host, config).catch(() => [host])
  const known = aliases.length > 1 ? preferredAlias(aliases, rows, config.net) : host
  return { host: known, label: hostDisplayName(known, rows[known]?.label) }
}
