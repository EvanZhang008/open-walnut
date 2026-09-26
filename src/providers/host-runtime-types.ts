/**
 * The shared shapes and the node-discovery shell snippet of host-runtime-core.ts,
 * kept apart from the factory so that file stays one self-contained function
 * (daemon-source.ts inlines it as text) and under the size limit. Everything
 * here is re-exported from host-runtime-core.ts; import from there.
 */

import type fsType from 'node:fs'
import type { ClaudeCheck, ClaudeCheckResult } from './claude-check-core.js'

/**
 * Shell twin of `findNode` for the spawn preambles (session-io REMOTE_BASE_PATH
 * and the binary daemon's buildSpawnPreamble). `node -v` EXECUTES node, because
 * an existence check passes a node that crashes on an old glibc. Stdout is
 * suppressed (it can be a JSONL stream) and it always exits 0 so `&&` chains
 * downstream keep running.
 */
export const NODE_DISCOVERY_SHELL = 'node -v >/dev/null 2>&1 || {'
  + ' if [ -s "$HOME/.nvm/nvm.sh" ]; then'
  + '   . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1;'
  + '   node -v >/dev/null 2>&1 || {'
  // nvm's default may need a newer glibc than the host has: try each installed
  // version, newest first, until one runs.
  + '     for v in $(ls -1r "$NVM_DIR/versions/node/" 2>/dev/null); do'
  + '       nvm use --delete-prefix "$v" >/dev/null 2>&1 && node -v >/dev/null 2>&1 && break;'
  + '     done; };'
  + ' elif [ -x "$HOME/.fnm/fnm" ]; then eval "$("$HOME/.fnm/fnm" env)" >/dev/null 2>&1;'
  + ' elif [ -d "$HOME/.volta" ]; then export PATH="$HOME/.volta/bin:$PATH";'
  + ' elif [ -s "$HOME/.asdf/asdf.sh" ]; then . "$HOME/.asdf/asdf.sh" >/dev/null 2>&1;'
  + ' fi;'
  + ' true; }'

type ExecCallback = (err: (Error & { code?: unknown; killed?: boolean; signal?: string | null }) | null, stdout: string | Buffer, stderr: string | Buffer) => void

export interface HostRuntimeDeps {
  fs?: Pick<typeof fsType, 'statSync' | 'accessSync' | 'openSync' | 'readSync' | 'closeSync' | 'readdirSync' | 'existsSync' | 'constants'>
  execFile?: (file: string, args: string[], opts: Record<string, unknown>, cb: ExecCallback) => unknown
  execFileSync?: (file: string, args: string[], opts: Record<string, unknown>) => string | Buffer
  /** Live reference (process.env), so later PATH edits are seen. */
  env: Record<string, string | undefined>
  now?: () => number
  /** process.platform / process.arch of the host, reported by preflight: the
   *  server plans host.fix and picks a prebuilt dtach by them. */
  platform?: string
  arch?: string
  /** Sign-in, version floor and install method (claude-check-core.ts). Absent = preflight omits them. */
  claudeCheck?: Pick<ClaudeCheck, 'check'>
  /**
   * The preamble this twin's CLI spawns run under `$SHELL -c` (the binary
   * twin's buildSpawnPreamble). Given, preflight asks that shell before it calls
   * claude missing or node-less, as the spawn gate does. Absent (the source twin
   * spawns claude directly on the daemon PATH) = the daemon PATH answers alone.
   */
  spawnPreamble?: () => string
}

export type ClaudeKind = 'native' | 'npm' | 'unknown'

export interface ClaudeProbe {
  found: boolean
  path?: string
  version?: string
  kind?: ClaudeKind
  needsNode?: boolean
  nodeFound?: boolean
  nodeVersion?: string
  error?: string
  /** From claudeCheck (daemons with it only): see claude-check-core.ts for the exact rule. */
  auth?: ClaudeCheckResult['auth']
  authDetail?: string
  versionOk?: boolean
  minVersion?: string
  installMethod?: ClaudeCheckResult['installMethod']
  /** Set (with the reason) when the probe could not tell: never read as missing. */
  unknown?: string
}

export interface HostPreflightResult {
  claude: ClaudeProbe
  compiler: { found: boolean; name?: string }
  dtach: { found: boolean; path?: string }
  /** process.platform ('linux', 'darwin', ...) and process.arch ('x64', 'arm64');
   *  absent from older daemons. */
  platform?: string
  arch?: string
}

export type EnsureClaudeResult =
  | { ok: true; path: string; kind: ClaudeKind; nodeDir?: string }
  | { ok: false; code: 'claude_missing' | 'claude_needs_node'; message: string; fixedInterpreter?: boolean }
