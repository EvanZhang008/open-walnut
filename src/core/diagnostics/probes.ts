/**
 * The doctor's probe set: one function per fact, each replaceable (tests pass
 * fakes; the server route passes the web-only ones). Defaults differ by who
 * collects: the server asks its local daemon and reads config through
 * getConfig (it owns config.yaml); the CLI never touches a daemon connection
 * and reads config.yaml read-only.
 */

import os from 'node:os'
import { getSelfApiRoot } from '../../lib/self-api-root.js'
import { CLOUD_MODE, CONFIG_FILE, TMP_DIR, WALNUT_HOME } from '../../constants.js'
import { DEFAULT_MODEL } from '../../model/providers/defaults.js'
import type { HostPreflightResult } from '../../providers/host-runtime-core.js'
import {
  captureLoginShellPath, localClaudePath, localCompiler, localPreflight, probeSqlite, readConfigReadOnly,
  readOnlyLocalDtach, summarizeConfig,
} from './local-probes.js'
import { daemonHello, listHostDiagnostics, localDaemonPreflight, type DaemonHello } from './host-probes.js'
import { claudeCliFloorFor, configuredClaudeCliFloor, type ClaudeCliFloor } from '../hosts/claude-version-floor.js'
import type { ConfigDiagnostics, HostDiagnostics, LocalDiagnostics, ServerDiagnostics } from './types.js'
import type { UpdateStatus } from '../self-update/update-check.js'

type Env = Record<string, string | undefined>

export interface DiagnosticsProbes {
  loginShellPath: (timeoutMs: number) => Promise<string | null>
  /** The local daemon's host.preflight; null when no daemon with 'preflight-v1' is connected. */
  daemonPreflight: (minVersion: string | undefined, timeoutMs: number) => Promise<HostPreflightResult | null>
  /** host.preflight in this process with the PATH a local session gets, checked against `minVersion`. */
  preflight: (pathStr: string, minVersion?: string) => Promise<HostPreflightResult>
  /** The oldest CLI the configured model runs on (claude-version-floor.ts); null = no floor. */
  claudeFloor: () => Promise<ClaudeCliFloor | null>
  /** Resolve `claude` without running it, for when the preflight runs out of time. */
  claudePath: (pathStr: string) => string | null
  compiler: (pathStr: string) => { found: boolean; name: string | null }
  dtach: (pathStr: string) => Promise<LocalDiagnostics['dtach']>
  sqlite: () => Promise<{ ok: boolean; version?: string }>
  /** null when this process does not serve the web app. */
  webAssets: () => Promise<boolean | null>
  config: () => Promise<ConfigDiagnostics>
  server: () => ServerDiagnostics
  hosts: () => Promise<HostDiagnostics[]>
  daemonHello: (host: string, timeoutMs: number) => Promise<DaemonHello | null>
  /** The update status, asking the registry when nothing has been checked yet. */
  update: () => Promise<UpdateStatus>
}

/**
 * The server's shared checker answers from its cache once it has checked; before
 * that (and always for the CLI, whose process is new) the registry is asked once.
 */
async function updateStatus(collector: 'server' | 'cli'): Promise<UpdateStatus> {
  const { getUpdateChecker, UpdateChecker } = await import('../self-update/update-check.js')
  const checker = collector === 'cli' ? new UpdateChecker() : getUpdateChecker()
  const cached = checker.status()
  if (!cached.enabled || cached.checkedAt) return cached
  return checker.checkNow()
}

function portOf(root: string | null): number | null {
  if (!root) return null
  try {
    const port = Number(new URL(root).port)
    return Number.isInteger(port) && port > 0 ? port : null
  } catch {
    return null
  }
}

export function defaultServer(): ServerDiagnostics {
  let nice: number | null = null
  try { nice = os.getPriority() } catch { /* diagnostics only */ }
  return {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    pid: process.pid,
    nice,
    port: portOf(getSelfApiRoot()),
    dataDir: WALNUT_HOME,
    uptimeMs: Math.round(process.uptime() * 1000),
    mode: CLOUD_MODE ? 'replica' : 'primary',
  }
}

/** The CLI's config: config.yaml as it is on disk, never recovered or rewritten. */
async function cliConfig(env: Env): Promise<ConfigDiagnostics> {
  const config = await readConfigReadOnly(CONFIG_FILE)
  if (!config) throw new Error('no config.yaml (first run, or it is missing); nothing was changed')
  return summarizeConfig(config, env)
}

async function cliFloor(): Promise<ClaudeCliFloor | null> {
  const config = await readConfigReadOnly(CONFIG_FILE)
  return claudeCliFloorFor(config?.agent?.main_model ?? DEFAULT_MODEL)
}

export function defaultDiagnosticsProbes(env: Env = process.env, collector: 'server' | 'cli' = 'server'): DiagnosticsProbes {
  const home = env.HOME || os.homedir()
  const cli = collector === 'cli'
  return {
    loginShellPath: (ms) => captureLoginShellPath(env, ms),
    daemonPreflight: cli ? async () => null : localDaemonPreflight,
    preflight: (p, min) => localPreflight(p, env, min),
    claudeFloor: cli ? cliFloor : configuredClaudeCliFloor,
    claudePath: (p) => localClaudePath(p, env),
    compiler: localCompiler,
    dtach: (p) => readOnlyLocalDtach(TMP_DIR, p, home),
    sqlite: probeSqlite,
    webAssets: async () => null,
    config: cli
      ? () => cliConfig(env)
      : async () => {
        const { getConfig } = await import('../config-manager.js')
        return summarizeConfig(await getConfig(), env)
      },
    server: defaultServer,
    hosts: listHostDiagnostics,
    daemonHello,
    update: () => updateStatus(collector),
  }
}
