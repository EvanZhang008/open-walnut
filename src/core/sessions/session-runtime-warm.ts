/**
 * Unpack the compiled file's runtime tree for session-side runs before a session needs it.
 *
 * Every session-side run of the compiled Walnut file (the walnut MCP mount, the
 * daemon's PATH shim behind `walnut ...`, the CLI hooks that call it) runs with
 * neither WALNUT_RUNTIME_DIR nor OPEN_WALNUT_HOME: the local daemon starts with no
 * OPEN_WALNUT_HOME (local-daemon.ts) and hands every CLI no WALNUT_RUNTIME_DIR
 * (daemon-standalone.ts, daemon-source.ts), because the server's own tree lives in
 * a deploy stage that a later deploy deletes. So they use the account's default
 * tree, `~/.open-walnut/local/runtime/<build>`, and the first one after a deploy
 * unpacks it (448 files, 28 MB) and prunes old builds' trees before it does
 * anything else. 2026-11-08: the first ask after a deploy waited 14.6 s for its
 * walnut MCP mount on a loaded Mac (5 s unpacking, 5 s pruning, the rest the new
 * file's cold start), and Claude Code starts the first turn only once the mount is
 * up, so the user read "Claude Code is working... 23s" over nothing and reported
 * Ask Walnut broken.
 *
 * The server does it at boot, in a child process (never on the event loop), by
 * running the very command the MCP mount runs with `--version` and the env a
 * session-side run has: the file unpacks and prunes as it would for the first
 * session, then exits. Isolated servers (tests, ephemeral, a smoke boot) skip it.
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { isComplete, runtimeRootsFor, RUNTIME_PLACE_ENV } from '../../binary/runtime-tree.js'
import { singleFile, type SingleFile } from '../../lib/single-file.js'
import { withUtilityQosClamp } from '../../lib/background-qos.js'
import { walnutMcpProfile } from './profiles.js'

/** The env a session-side run of the file has, as far as its runtime tree goes: none of RUNTIME_PLACE_ENV. */
export function sessionRuntimeEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base }
  for (const key of RUNTIME_PLACE_ENV) delete env[key]
  return env
}

/** The tree a session-side run of build `id` uses first. */
export function sessionRuntimeRoot(id: string, base: NodeJS.ProcessEnv = process.env): string {
  return runtimeRootsFor(sessionRuntimeEnv(base), id)[0]!
}

type Mount = { command: string; args?: string[]; env?: Record<string, string> }

/** The MCP mount's run with `mcp` swapped for `--version`; null when it does not run this file. */
export function warmCommand(info: SingleFile | null, mount: Mount | undefined, execPath: string): { command: string; args: string[]; env: Record<string, string> } | null {
  if (!info || !mount || mount.command !== execPath) return null
  const args = [...(mount.args ?? [])]
  const at = args.lastIndexOf('mcp')
  if (at < 0) return null
  args.splice(at, 1, '--version')
  return { command: mount.command, args, env: mount.env ?? {} }
}

export type WarmResult =
  | { state: 'skipped'; reason: string }
  | { state: 'ready'; root: string }
  | { state: 'warmed' | 'failed'; root: string; ms: number; code: number | null; error?: string }

export interface WarmDeps {
  isolated: boolean
  /** Defaults: this process's file, its MCP mount, its env, node's spawn (tests replace them). */
  info?: SingleFile | null
  mount?: Mount
  execPath?: string
  env?: NodeJS.ProcessEnv
  spawnFn?: typeof spawn
}

export async function warmSessionRuntime(deps: WarmDeps): Promise<WarmResult> {
  if (deps.isolated) return { state: 'skipped', reason: 'isolated server' }
  const info = deps.info === undefined ? singleFile() : deps.info
  const cmd = warmCommand(info, deps.mount ?? walnutMcpProfile().mcpServers?.walnut, deps.execPath ?? process.execPath)
  if (!info || !cmd) return { state: 'skipped', reason: 'not the compiled file' }
  const id = path.basename(info.root)
  // What the mount's process gets: a session-side env, then the mount's own.
  const env = { ...sessionRuntimeEnv(deps.env ?? process.env), ...cmd.env }
  const root = runtimeRootsFor(env, id)[0]!
  if (isComplete(root, id)) return { state: 'ready', root }
  const started = Date.now()
  // No env here: the clamp request was read and removed at boot (takeQosClampRequest),
  // so only the default reads the server's cached decision.
  const [program, args] = withUtilityQosClamp(cmd.command, cmd.args)
  return new Promise<WarmResult>((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = (deps.spawnFn ?? spawn)(program, args, { env, stdio: 'ignore' })
    } catch (err) {
      resolve({ state: 'failed', root, ms: Date.now() - started, code: null, error: err instanceof Error ? err.message : String(err) })
      return
    }
    let done = false
    const settle = (code: number | null, error?: string) => {
      if (done) return
      done = true
      resolve({ state: isComplete(root, id) ? 'warmed' : 'failed', root, ms: Date.now() - started, code, ...(error ? { error } : {}) })
    }
    // A child that never starts emits 'error' and maybe no 'close'.
    child.once('error', (err) => settle(null, err.message))
    child.once('close', (code) => settle(code))
  })
}
