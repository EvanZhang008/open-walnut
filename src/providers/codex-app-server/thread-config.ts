/**
 * The thread config a direct Codex thread starts with (thread/start, thread/resume), as
 * the codex-acp adapter built it, and what the host's own Codex config says that Walnut
 * keeps (its MCP server names, its workspace-write sandbox table). Plus two small helpers
 * of the connection.
 */

import type { AppServerRpc } from './rpc.js'
import type { AcpMcpServer } from '../acp-worker/protocol.js'
import type { WorkspaceWriteTable } from './controls.js'

const CONFIG_READ_TIMEOUT_MS = 20_000

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * The thread config, as the adapter built it: CODEX_CONFIG, the session folder
 * trusted (so its project instructions load), and the session's MCP mounts unless
 * Codex's own config already names a server of that name.
 */
export async function buildThreadConfig(
  rpc: AppServerRpc, base: Record<string, unknown>, env: NodeJS.ProcessEnv, cwd: string, mcpServers: AcpMcpServer[] | undefined,
): Promise<{ config: Record<string, unknown>; workspaceWrite?: WorkspaceWriteTable }> {
  const config: Record<string, unknown> = { ...base }
  const projects = isRecord(config.projects) ? { ...config.projects } : {}
  projects[cwd] = { ...(isRecord(projects[cwd]) ? projects[cwd] as Record<string, unknown> : {}), trust_level: 'trusted' }
  config.projects = projects
  const host = await readHostConfig(rpc, cwd)
  if (mcpServers && mcpServers.length > 0) {
    const own = env.DISABLE_MCP_CONFIG_FILTERING === 'true' ? new Set<string>() : host.mcpNames
    const mounts: Record<string, unknown> = isRecord(config.mcp_servers) ? { ...config.mcp_servers } : {}
    for (const server of mcpServers) {
      const name = server.name.replace(/\s/gu, '_')
      if (own.has(name)) continue
      mounts[name] = {
        command: server.command,
        args: [...server.args],
        ...(server.env.length > 0 ? { env: Object.fromEntries(server.env.map((e) => [e.name, e.value])) } : {}),
      }
    }
    if (Object.keys(mounts).length > 0) config.mcp_servers = mounts
  }
  return { config, workspaceWrite: host.workspaceWrite }
}

/** What the host's own Codex config says for this folder: its MCP server names and workspace-write table. */
async function readHostConfig(rpc: AppServerRpc, cwd: string): Promise<{ mcpNames: Set<string>; workspaceWrite?: WorkspaceWriteTable }> {
  const mcpNames = new Set<string>()
  let workspaceWrite: WorkspaceWriteTable | undefined
  try {
    const resp: Record<string, unknown> = await rpc.request('config/read', { includeLayers: true, cwd }, CONFIG_READ_TIMEOUT_MS)
    const add = (c: unknown) => { if (isRecord(c) && isRecord(c.mcp_servers)) for (const n of Object.keys(c.mcp_servers)) mcpNames.add(n) }
    add(resp.config)
    for (const layer of Array.isArray(resp.layers) ? resp.layers : []) add(isRecord(layer) ? layer.config : undefined)
    if (isRecord(resp.config) && isRecord(resp.config.sandbox_workspace_write)) workspaceWrite = resp.config.sandbox_workspace_write
  } catch { /* unread: every mount is offered, the mode's sandbox as it is */ }
  return { mcpNames, workspaceWrite }
}

/** Codex's last model call of the turn, as ACP PromptResponse.usage: input net of the cached part, as the adapter reported it. */
export function turnUsage(tokenUsage: Record<string, unknown>): Record<string, number> | undefined {
  const last = isRecord(tokenUsage.last) ? tokenUsage.last : undefined
  if (!last) return undefined
  const pick = (key: string): number | undefined => typeof last[key] === 'number' ? last[key] as number : undefined
  const out: Record<string, number> = {}
  const pairs: Array<[string, number | undefined]> = [
    ['totalTokens', pick('totalTokens')],
    ['inputTokens', pick('inputTokens') !== undefined ? (pick('inputTokens') as number) - (pick('cachedInputTokens') ?? 0) : undefined],
    ['cachedReadTokens', pick('cachedInputTokens')], ['outputTokens', pick('outputTokens')],
    ['thoughtTokens', pick('reasoningOutputTokens')],
  ]
  for (const [k, v] of pairs) if (v !== undefined) out[k] = v
  return Object.keys(out).length > 0 ? out : undefined
}

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms)
    promise.then((v) => { clearTimeout(timer); resolve(v) }, () => { clearTimeout(timer); resolve(undefined) })
  })
}
