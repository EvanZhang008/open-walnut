/**
 * The Walnut config a Codex spawn reads `engines.codex` from. On the Mac, its own.
 * On any other server (the cloud companion while it leads, a host's server), the
 * Mac's engine settings come from that server's copy of the Mac's config
 * (replication/config-allowlist.ts copies provider, model and effort, never env),
 * laid over its own config; the rest (env, session settings) stays its own.
 *
 * A server that cannot tell what the Mac set refuses the start instead of letting
 * Codex use the host's own provider (the managed one a host's config.toml names):
 * no copy yet, a Mac too old to copy engine settings, or a provider the Mac could
 * not copy because it holds a credential (readProvider's `withheld`).
 *
 * The provider is then the one for the machine the Codex process runs on
 * (codex-engine-config.ts codexProviderForPlace): a host's own, else the global one,
 * except a loopback global anywhere but the leader's own machine.
 */
import { CodexEngineConfigError, codexProviderForPlace, type CodexProviderSource } from './codex-engine-config.js'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/** The keys of `engines.<id>` the Mac's copy carries. */
const COPIED_ENGINE_KEYS = ['provider', 'model', 'effort', 'transport'] as const

/** `own` with the copy's engine settings over it. Throws when the copy cannot say. */
export function withCopiedEngines(own: Record<string, unknown>, copy: Record<string, unknown> | null): Record<string, unknown> {
  if (!copy) {
    throw new CodexEngineConfigError('this server holds no copy of the Mac\'s settings yet, so it cannot tell which provider Codex must use. Start the session from the Mac, or try again once the copy has arrived')
  }
  if (!Object.hasOwn(copy, 'engines')) {
    throw new CodexEngineConfigError('the Mac\'s Walnut is older than copying engine settings, so this server cannot tell which provider Codex must use. Update Walnut on the Mac, or start the session from the Mac')
  }
  const ownEngines = isRecord(own.engines) ? own.engines : {}
  const copied = isRecord(copy.engines) ? copy.engines : {}
  const engines: Record<string, unknown> = {}
  for (const id of new Set([...Object.keys(ownEngines), ...Object.keys(copied)])) {
    const mine = isRecord(ownEngines[id]) ? { ...ownEngines[id] } : {}
    for (const key of COPIED_ENGINE_KEYS) delete mine[key]
    const theirs = isRecord(copied[id]) ? copied[id] : {}
    engines[id] = { ...mine, ...Object.fromEntries(COPIED_ENGINE_KEYS.filter((k) => theirs[k] !== undefined).map((k) => [k, theirs[k]])) }
  }
  const out: Record<string, unknown> = { ...own, engines }
  if (own.hosts !== undefined || copy.host_engines !== undefined) out.hosts = withCopiedHostEngines(own.hosts, copy.host_engines)
  return out
}

/**
 * `own`'s hosts with each host's `engines` the leader's copy says (its copy-only row
 * `host_engines`, replication/config-allowlist.ts): a host's own provider is the leader's
 * setting, never this server's. A copy from a leader older than the row has none.
 */
function withCopiedHostEngines(own: unknown, copied: unknown): Record<string, unknown> {
  const hosts: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(isRecord(own) ? own : {})) {
    if (!isRecord(entry)) { hosts[key] = entry; continue }
    const { engines: _mine, ...rest } = entry
    hosts[key] = rest
  }
  for (const [key, engines] of Object.entries(isRecord(copied) ? copied : {})) {
    if (!isRecord(engines)) continue
    hosts[key] = { ...(isRecord(hosts[key]) ? hosts[key] as Record<string, unknown> : {}), engines }
  }
  return hosts
}

/** Where a Codex process runs: a host key, or absent (or '__local__') for this server's machine. */
export interface CodexSpawnPlace { host: string | undefined }

const noted = new Set<string>()

/** One line per host and URL: a Codex start there was refused, and why (the start itself says so to the session). */
function noteSource(source: CodexProviderSource, log: (msg: string, meta: Record<string, unknown>) => void): void {
  if (source.from !== 'refused-loopback') return
  const key = `${source.host ?? ''}|${source.base_url}`
  if (noted.has(key)) return
  noted.add(key)
  log('codex: a start was refused: the global engines.codex.provider is a loopback address of the machine whose config it is, which is not this host, and the host has no provider of its own (hosts.<name>.engines.codex.provider)', {
    host: source.host ?? '(this server)', provider: source.name, base_url: source.base_url,
  })
}

/** This leader's own daemon link is up (dialled now when it is not, within a few seconds); false when it cannot be. */
async function localDaemonLinked(): Promise<boolean> {
  try {
    const { getLocalDaemonConnection } = await import('./local-daemon-dial.js')
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), LOCAL_LINK_DEADLINE_MS) })
    const linked = await Promise.race([getLocalDaemonConnection().then(() => true, () => false), deadline])
    clearTimeout(timer)
    return linked
  } catch {
    return false
  }
}
const LOCAL_LINK_DEADLINE_MS = 5_000

/** Tests only. */
export function _resetCodexSourceNotesForTesting(): void { noted.clear() }

/**
 * The config to resolve a Codex spawn at `place` against on this server, its
 * `engines.codex.provider` already the one for that place (codexProviderForPlace): the
 * host's own, else the global one unless it is a loopback URL of another machine. Every
 * Codex spawn path reads it here (tests/providers/codex-engine-config-ratchet.test.ts).
 */
export async function codexWalnutConfig(place: CodexSpawnPlace): Promise<Record<string, unknown>> {
  const { getConfig } = await import('../core/config-manager.js')
  const own = (await getConfig()) as unknown as Record<string, unknown>
  const { isFollower } = await import('../core/server-role.js')
  const follower = isFollower()
  let config = own
  if (follower) {
    const { readConfigCopy } = await import('../core/replication/kinds/config.js')
    config = withCopiedEngines(own, await readConfigCopy())
  }
  const remote = place.host && place.host !== '__local__' ? place.host : undefined
  // A session on this machine: a host replica goes by its own host key, the leader by none.
  const { thisHostKey } = await import('../core/sessions/session-row-owner.js')
  const host = remote ?? (thisHostKey() || undefined)
  // The host's other names, and whether it is this leader's own machine: only the tie the
  // leader's own links prove (one live daemon process, revoked-hosts.ts sameDaemonKeysNow).
  const { sameDaemonKeysNow } = await import('../core/session-channel/revoked-hosts.js')
  const resolve = () => {
    const ties = host ? sameDaemonKeysNow(host) : []
    const thisMachine = !follower && (!remote || ties.includes('__local__'))
    return codexProviderForPlace(config, { host, aliases: ties.filter((k) => k !== '__local__'), configIsThisMachine: thisMachine })
  }
  let resolved = resolve()
  // A host key that may be this leader's own machine is told apart only by both daemon links being
  // up (a start dials the host's before it builds the env; this leader's own may not be up yet,
  // right after a restart): this leader's own is dialled before a refusal stands.
  if (resolved.source.from === 'refused-loopback' && !follower && remote && await localDaemonLinked()) resolved = resolve()
  if (resolved.source.from === 'refused-loopback') {
    const { log } = await import('../logging/index.js')
    noteSource(resolved.source, (msg, meta) => log.session.warn(msg, meta))
  }
  return resolved.config
}
