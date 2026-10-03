/**
 * Every MCP server registered on this Walnut, by name. A plugin registers through
 * `walnut.mcp.register` and the registration is owned by the plugin: its dispose closes the
 * process, and a plugin reload registers again from scratch.
 */

import { bus } from '../event-bus.js'
import { CLOUD_MODE } from '../../constants.js'
import { createSubsystemLogger } from '../../logging/index.js'
import { getVersion } from '../version.js'
import { McpConnection, resolveDefinition } from './connection.js'
import { MCP_SERVER_NAME, MCP_STATUS_EVENT, type McpServerDefinition, type McpServerStatus } from './types.js'

const log = createSubsystemLogger('mcp')
const servers = new Map<string, McpConnection>()

function announce(name: string): void {
  const connection = servers.get(name)
  bus.emit(MCP_STATUS_EVENT, { name, status: connection ? connection.status() : null }, ['web-ui'], { source: 'mcp' })
}

export function validateDefinition(def: McpServerDefinition): void {
  if (!def || typeof def !== 'object') throw new Error('An MCP server definition is an object')
  if (typeof def.name !== 'string' || !MCP_SERVER_NAME.test(def.name)) {
    throw new Error(`MCP server name "${String(def.name)}" must be lowercase letters, digits, ".", "_" or "-"`)
  }
  if (typeof def.command !== 'string' || !def.command.trim()) throw new Error(`MCP server "${def.name}" needs a command`)
  if (def.args !== undefined && (!Array.isArray(def.args) || def.args.some((arg) => typeof arg !== 'string'))) {
    throw new Error(`MCP server "${def.name}": args must be strings`)
  }
  if (def.env !== undefined && (typeof def.env !== 'object' || Object.values(def.env).some((value) => typeof value !== 'string'))) {
    throw new Error(`MCP server "${def.name}": env values must be strings`)
  }
  if (def.sessions !== undefined && !['read-only', 'all', 'none'].includes(def.sessions)) {
    throw new Error(`MCP server "${def.name}": sessions is read-only, all or none`)
  }
}

/** Register a server for `owner` (a plugin id). Throws when another owner already holds the name. */
export function registerMcpServer(owner: string, def: McpServerDefinition): { dispose(): Promise<void> } {
  validateDefinition(def)
  const existing = servers.get(def.name)
  if (existing && existing.owner !== owner) {
    throw new Error(`MCP server "${def.name}" is already registered by ${existing.owner}`)
  }
  if (existing) void existing.dispose()
  const connection = new McpConnection(resolveDefinition(def), owner, {
    onStatus: () => { if (servers.get(def.name) === connection) announce(def.name) },
    log,
    replica: CLOUD_MODE,
    clientVersion: getVersion(),
  })
  servers.set(def.name, connection)
  log.info('mcp server registered', { server: def.name, owner })
  announce(def.name)
  return {
    async dispose() {
      if (servers.get(def.name) === connection) {
        servers.delete(def.name)
        announce(def.name)
      }
      await connection.dispose()
    },
  }
}

export function getMcpConnection(name: string): McpConnection | undefined {
  return servers.get(name)
}

export function listMcpServers(): McpServerStatus[] {
  return [...servers.values()].map((connection) => connection.status()).sort((a, b) => a.name.localeCompare(b.name))
}

/** Server shutdown: close every process and drop every registration, so nothing starts one again. */
export async function closeAllMcpServers(): Promise<void> {
  await Promise.all([...servers.values()].map((connection) => connection.dispose()))
  servers.clear()
}
