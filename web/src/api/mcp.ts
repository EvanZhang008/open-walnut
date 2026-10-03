/**
 * The MCP servers plugins registered (server: src/core/mcp-servers/, routes /api/mcp), as one
 * shared live list: a single fetch for every Settings row that shows one, then the server's
 * `mcp:status-changed` events, and a fresh fetch after the socket reconnects (events sent while
 * it was down are gone).
 */
import { useSyncExternalStore } from 'react'
import { apiGet, apiPost } from './client'
import { wsClient, type ConnectionState } from './ws'

export type McpServerState = 'idle' | 'starting' | 'ready' | 'failed'

export interface McpServerStatus {
  name: string
  title: string
  /** The plugin that registered it. */
  owner: string
  state: McpServerState
  since: number
  sessions: 'read-only' | 'all' | 'none'
  toolCount?: number
  serverInfo?: { name: string; version: string }
  lastError?: string
}

export const MCP_STATUS_EVENT = 'mcp:status-changed'

export function fetchMcpServers(): Promise<{ servers: McpServerStatus[] }> {
  return apiGet<{ servers: McpServerStatus[] }>('/api/mcp/servers')
}

/** Answers within ~15s; a start still running then finishes on its own and arrives as an event. */
export function restartMcpServer(name: string): Promise<{ server: McpServerStatus }> {
  return apiPost<{ server: McpServerStatus }>(`/api/mcp/servers/${encodeURIComponent(name)}/restart`, {}, { timeoutMs: 20_000 })
}

let servers: McpServerStatus[] = []
let generation = 0
const listeners = new Set<() => void>()

function publish(next: McpServerStatus[]): void {
  servers = next
  for (const listener of listeners) listener()
}

function load(): void {
  const mine = ++generation
  fetchMcpServers().then((body) => {
    // An event that arrived after this request left is newer than its answer.
    if (mine === generation) publish(body.servers)
  }, () => { /* keep what we had; the next event or reconnect fills it */ })
}

function onStatus(data: unknown): void {
  const change = data as { name?: unknown; status?: McpServerStatus | null } | undefined
  if (!change || typeof change.name !== 'string') return
  generation += 1
  const rest = servers.filter((one) => one.name !== change.name)
  publish(change.status ? [...rest, change.status].sort((a, b) => a.name.localeCompare(b.name)) : rest)
}

/** A status a request answered with (a restart), for a window whose socket missed the event. */
export function noteMcpStatus(status: McpServerStatus): void {
  onStatus({ name: status.name, status })
}

function onConnection(state: ConnectionState): void {
  if (state === 'connected') load()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (listeners.size === 1) {
    wsClient.onEvent(MCP_STATUS_EVENT, onStatus)
    wsClient.onConnectionChange(onConnection)
    load()
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      wsClient.offEvent(MCP_STATUS_EVENT, onStatus)
      wsClient.offConnectionChange(onConnection)
    }
  }
}

const snapshot = () => servers

export function useMcpServers(): McpServerStatus[] {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}
