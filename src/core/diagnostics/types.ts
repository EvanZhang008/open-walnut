/**
 * The `open-walnut doctor` report: ONE artifact that answers the questions a
 * support thread otherwise asks one at a time (which build, which claude, which
 * node, which PATH, what each host can run). Built by collect.ts, rendered by
 * render.ts, served by GET /api/diagnostics and printed by `open-walnut doctor`.
 *
 * Contract: no secrets by construction. Every field is picked from an allowlist
 * (never a spread of config or env), so a token in the environment or in
 * config.yaml has no path into this shape.
 */

import type { BuildInfo } from '../../lib/build-info.js'
import type { HostReadiness } from '../hosts/host-readiness.js'
import type { ClaudeKind } from '../../providers/host-runtime-core.js'

/** A PATH, shortened: the first entries in order plus how many there are. */
export interface PathSummary {
  entries: string[]
  count: number
}

export interface ServerDiagnostics {
  node: string
  platform: string
  arch: string
  pid: number
  /** os.getPriority(): > 0 means the server inherited a positive nice and starves under load. */
  nice: number | null
  port: number | null
  dataDir: string
  uptimeMs: number
  /** 'replica' on a cloud companion. */
  mode: 'primary' | 'replica'
}

export interface LocalClaudeDiagnostics {
  found: boolean
  path: string | null
  version: string | null
  kind: ClaudeKind | null
  /** Only for the npm build, which needs Node.js to start. */
  node?: { found: boolean; version: string | null }
  /** Signed in, as `claude auth status` (or its presence fallback) says; see claude-check-core.ts. */
  auth?: 'ok' | 'not-logged-in' | 'unknown'
  /** How it signs in ("Bedrock", "a Claude account") or why that is unknown. Never an email or org. */
  authDetail?: string
  /** False = older than `minVersion`, the configured model's floor. */
  versionOk?: boolean
  minVersion?: string
  /** What stops it from running, in the preflight's own words. */
  error?: string
  /** Set when the check did not finish ("preflight timed out"): found/version are then unknown, not false. */
  unknown?: string
}

export interface LocalDiagnostics {
  /** The node running the collector (the server, or the CLI when no server is up). */
  node: { version: string; path: string }
  claude: LocalClaudeDiagnostics
  /** PATH captured from the user's login shell, the one sessions start from. */
  loginShellPath: PathSummary | null
  /** PATH this process inherited. */
  processPath: PathSummary
  shell: string | null
  /** Who answered the claude preflight: the local daemon (what sessions get), or this process. */
  preflightSource: 'daemon' | 'in-process' | null
  compiler: { found: boolean; name: string | null; unknown?: string }
  /** `unknown` = still resolving or the check failed (never "not found"); `note` = why it is missing. */
  dtach: { found: boolean; path: string | null; source: string | null; unknown?: string; note?: string }
  sqliteOk: boolean | null
  sqliteVersion?: string
  /** null when this process does not serve the web app (dev, the CLI). */
  webAssetsOk: boolean | null
}

export interface HostDiagnostics {
  alias: string
  label: string
  hostname: string
  /** ssh user, when configured. Masked by redactDiagnostics. */
  user?: string
  connected: boolean
  phase: string
  /** 'bun' | 'binary' | 'node' once the connection knows it; null when unknown. */
  runtime: string | null
  daemonVersion: string | null
  /** Where the daemon keeps its files; `fallback` = moved off /tmp (the warning says why). */
  daemonDir?: { display: string; fallback: boolean; freeMb?: number; home?: string } | null
  /** Lines the host status carries even when nothing is broken. */
  warnings?: string[]
  /** The host.preflight answer, exactly as Settings reads it. */
  readiness: HostReadiness | null
  lastError: string | null
}

export interface ConfigDiagnostics {
  provider: string | null
  mainProvider: string | null
  mainModel: string | null
  fastModel: string | null
  /** `name (protocol)` per configured provider; never a key or a URL. */
  providers: string[]
  engine: string
  hostsConfigured: number
  searchDisabled: boolean
}

export interface DiagnosticsReport {
  generatedAt: string
  /** Who collected it: the running server, or the CLI on its own. */
  collector: 'server' | 'cli'
  build: BuildInfo
  /** null when collected by the CLI with no server running. */
  server: ServerDiagnostics | null
  local: LocalDiagnostics
  hosts: HostDiagnostics[]
  config: ConfigDiagnostics | null
  /** Every probe that failed or timed out, as one line each. Never thrown. */
  warnings: string[]
}
