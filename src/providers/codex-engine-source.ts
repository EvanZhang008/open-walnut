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
 */
import { CodexEngineConfigError } from './codex-engine-config.js'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/** The keys of `engines.<id>` the Mac's copy carries. */
const COPIED_ENGINE_KEYS = ['provider', 'model', 'effort'] as const

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
  return { ...own, engines }
}

/** The config to resolve a Codex spawn against on this server. */
export async function codexWalnutConfig(): Promise<Record<string, unknown>> {
  const { getConfig } = await import('../core/config-manager.js')
  const own = (await getConfig()) as unknown as Record<string, unknown>
  const { placement } = await import('../core/server-role.js')
  if (placement() === 'mac') return own
  const { readConfigCopy } = await import('../core/replication/kinds/config.js')
  return withCopiedEngines(own, await readConfigCopy())
}
