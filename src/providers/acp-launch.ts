/**
 * What an ACP engine's worker is launched with: its commands and the operator's env
 * overlay, read from walnut config. One copy for every launcher: a task session
 * (acp-session.ts) and a light subagent (core/subagents/light-subagent-acp.ts).
 */
import fsModule from 'node:fs'
import type { SessionEngine } from '../core/types.js'
import { engineCaps } from '../core/agents/engine-registry.js'
import { hostAdapterSpec } from '../core/agents/host-adapter-spec.js'
import type { AcpHostAdapterSpec } from './acp-host-artifacts.js'
import { engineEnvOverlayFromConfig, resolveAcpArtifacts } from './acp-session.js'

export type AcpLaunchArtifacts = { workerCmd: string[]; adapterCmd: string[] } | { hostAdapter: AcpHostAdapterSpec }

/**
 * argv for engines whose adapter comes from walnut config (source 'config'), so
 * resolveAcpArtifacts stays synchronous for every other engine. Unreadable config
 * reads as "not configured": resolveAcpArtifacts then names the config key.
 */
export async function configuredAdapterCmd(engine: SessionEngine): Promise<string[] | undefined> {
  if (engineCaps(engine).acpAdapter?.source !== 'config') return undefined
  try {
    const { getConfig } = await import('../core/config-manager.js')
    const config = await getConfig()
    // Read structurally: engines.* is an optional additive config section.
    const raw = (config as { engines?: Record<string, { adapter_cmd?: unknown } | undefined> })
      .engines?.[engine]?.adapter_cmd
    if (!Array.isArray(raw)) return undefined
    return raw.filter((arg): arg is string => typeof arg === 'string' && arg !== '')
  } catch {
    return undefined
  }
}

/** Operator env overlay from `engines.<id>.env` (engineEnvOverlayFromConfig); unreadable config = none. */
export async function configuredEngineEnv(engine: SessionEngine): Promise<Record<string, string> | undefined> {
  try {
    const { getConfig } = await import('../core/config-manager.js')
    return engineEnvOverlayFromConfig(await getConfig(), engine)
  } catch {
    return undefined
  }
}

/**
 * The worker and adapter commands for `engine`. On another host its daemon builds
 * both from what that host has (acp-host-artifacts.ts), so only the spec travels.
 */
export async function acpLaunchArtifacts(engine: SessionEngine, remote: boolean): Promise<AcpLaunchArtifacts> {
  if (remote) {
    const spec = hostAdapterSpec(engine)
    if (!spec) throw new Error(`${engineCaps(engine).displayName} runs on this machine only: its adapter command is this machine's config`)
    return { hostAdapter: spec }
  }
  const artifacts = resolveAcpArtifacts(engine, { configuredAdapterCmd: await configuredAdapterCmd(engine) })
  // Without Bun, build-daemon.sh skips the worker bundle (Claude sessions never need
  // it). Fail here, before the daemon spawns a path that does not exist, and name the fix.
  if (!fsModule.existsSync(artifacts.workerCmd[1])) {
    throw new Error(
      `Engine '${engine}' runs on the ACP worker, which is not built (${artifacts.workerCmd[1]}). `
      + 'Install Bun (https://bun.sh) and run `bun run build:daemon`, or install the released Walnut, which ships it.',
    )
  }
  return artifacts
}
