/**
 * Which Walnut MCP mount a new Claude Code session gets (`--mcp-config`).
 *
 * A session reaches Walnut two ways: the `walnut` CLI in Bash, and the Walnut MCP
 * tools. The mount is the host's own `walnut mcp-server` (src/providers/walnut-mcp-stdio.ts),
 * which relays every call through the session's host daemon exactly as the CLI
 * does, so it works on every host, the Mac and a remote dev box alike. It is
 * started through the session's own `WALNUT_AGENT_SOCKET` (`<daemon dir>/agent-gateway.sock`,
 * the shim beside it in `<daemon dir>/bin`), never a `walnut` on PATH: on a Mac
 * with Walnut installed, PATH's `walnut` is the hub CLI, which has no such command.
 *
 * Decided once, at a session's first spawn: the result is stored on the session
 * record's profile, and every later spawn (a resume) replays that, so a session
 * that started without the tools keeps running without them.
 *
 * Context cost (Claude Code 2.1.312, measured 2026-11-01): Claude Code defers MCP
 * tools behind ToolSearch, so the 150-odd tools cost about 2K tokens at session
 * start; the hub's `open-walnut mcp`, which marks every tool always-load, costs
 * about 76K.
 */
import type { SessionMcpServer, SessionProfile } from '../types.js'

/** The daemon capability saying its `walnut` CLI serves `walnut mcp-server`. */
export const WALNUT_MCP_CAPABILITY = 'walnut-mcp-v1'

/** Whether a Claude Code session gets the mount when config `session.premount_walnut_mcp` is unset. */
export const WALNUT_MCP_DEFAULT = true

/** The mount: the session's host daemon's own `walnut`, found from the socket it injected. */
export function hostWalnutMcpServer(): SessionMcpServer {
  return {
    command: '/bin/sh',
    // No `${...}`: Claude Code expands `${VAR}` in --mcp-config itself, before the shell runs.
    args: ['-c', 'exec "$(dirname "$WALNUT_AGENT_SOCKET")/bin/walnut" mcp-server'],
  }
}

export interface WalnutMcpMountInput {
  /** config `session.premount_walnut_mcp` (undefined = WALNUT_MCP_DEFAULT). */
  setting: boolean | undefined
  /** The profile the caller asked for. */
  profile: SessionProfile | undefined
  /** This server is a cloud replica, whose gateway runs no op. */
  cloud?: boolean
  /** The session's host daemon advertises WALNUT_MCP_CAPABILITY. */
  hostServesMcp: boolean
  /** The session runs on this machine (the hub's own `open-walnut mcp` reaches the API there). */
  local: boolean
  /** The hub's own mount (profiles.ts walnutMcpProfile), for a local session whose daemon is older. */
  hubMount: () => SessionProfile
}

/** The profile the session spawns with: the caller's, plus the Walnut mount when it gets one. */
export function withWalnutMcpMount(input: WalnutMcpMountInput): SessionProfile | undefined {
  const { profile } = input
  const on = input.setting ?? WALNUT_MCP_DEFAULT
  if (!on || input.cloud || profile?.slim) return profile
  // A caller that brings its own profile has chosen its tools: the Personal AI's and
  // an ask's already mount walnut, the companion's chat lane takes it out on purpose,
  // and the record may already hold that profile, so adding one here would make the
  // first process and a resumed one differ. Only the old explicit opt-in adds to it.
  if (profile?.mcpServers?.walnut || (profile && input.setting !== true)) return profile
  let walnut: SessionMcpServer | undefined
  if (input.hostServesMcp) walnut = hostWalnutMcpServer()
  // The old opt-in, kept for a daemon that predates the host server: only a local
  // session can reach the API the hub's mount calls. Never by default, because it
  // lists every schema up front.
  else if (input.setting === true && input.local) walnut = input.hubMount().mcpServers?.walnut
  if (!walnut) return profile
  return { ...(profile ?? {}), mcpServers: { ...(profile?.mcpServers ?? {}), walnut } }
}
