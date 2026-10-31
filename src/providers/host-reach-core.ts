/**
 * The host-reach-core.cjs sidecar for the source twin: a task on another host
 * calling this host's MCP servers (host-mcp-core.ts, 'host-mcp-v1') and its web
 * services (host-http-core.ts, 'host-http-v1'). The binary twin imports both directly.
 */
export { createHostMcp } from './host-mcp-core.js'
export { createHostHttp } from './host-http-core.js'
