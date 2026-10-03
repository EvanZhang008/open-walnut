/**
 * MCP servers Walnut runs for its plugins, reachable from a session (src/core/mcp-servers/,
 * routes in src/web/routes/mcp-servers.ts). `walnut mcp <server> tools …` is the short form of
 * these four ops.
 *
 * Reads go anywhere a read may (`remote: 'allow'`), and only reach tools the server itself marks
 * read-only. Anything that may change something is `mcp_call`: this Mac only, and only on a
 * server whose plugin opened it to sessions. A plugin that puts its writes behind an approval
 * (posting to a chat) keeps that approval, because its server stays read-only to everyone else.
 */

import { z } from 'zod'
import { defineOp } from './registry.js'

const SERVER = z.string().min(1).max(64).describe('Server name, as `mcp_servers` lists it')
const TOOL = z.string().min(1).max(128).describe('Tool name, as `mcp_tools` lists it')
const ARGUMENTS = z.record(z.string(), z.unknown()).optional().describe('The tool\'s arguments (its inputSchema)')
const TIMEOUT = z.number().int().min(1).max(300_000).optional().describe('Deadline in ms (default: the server\'s, usually 60000)')
/** Long enough for a first start plus the call; the route enforces the real deadline. */
const OP_TIMEOUT_MS = 6 * 60_000

defineOp({
  name: 'mcp_servers',
  title: 'List MCP servers',
  description:
    'The MCP servers Walnut runs for its plugins: name, owner plugin, state (idle starts on first use, '
    + 'ready, starting, failed with the reason), tool count once known, and `sessions`: what you may call '
    + '(read-only: tools the server marks read-only, via mcp_read; all: also mcp_call from this Mac; '
    + 'none: plugin only). Listing never starts a server.',
  input: {},
  bind: { method: 'GET', path: '/api/mcp/servers' },
  tags: { readonly: true, remote: 'allow' },
})

defineOp({
  name: 'mcp_tools',
  title: 'List one MCP server\'s tools',
  description:
    'Every tool of one server with its description, input schema and whether it is read-only (callable '
    + 'with mcp_read). Starts the server when it is not running.',
  input: {
    server: SERVER,
    refresh: z.enum(['1']).optional().describe('"1" asks the server again instead of the 10-minute cache'),
  },
  bind: { method: 'GET', path: '/api/mcp/servers/:server/tools' },
  timeoutMs: OP_TIMEOUT_MS,
  tags: { readonly: true, remote: 'allow' },
})

defineOp({
  name: 'mcp_read',
  title: 'Call a read-only MCP tool',
  description:
    'Call one tool the server marks read-only. Returns { isError, data } (the tool\'s JSON answer) or '
    + '{ isError, text }. A tool that may change something is refused here: use mcp_call where the server '
    + 'allows it, or the owning plugin\'s own op (a post that needs the user\'s approval goes through it).',
  input: { server: SERVER, tool: TOOL, arguments: ARGUMENTS, timeout_ms: TIMEOUT },
  bind: { method: 'POST', path: '/api/mcp/servers/:server/read' },
  timeoutMs: OP_TIMEOUT_MS,
  tags: { readonly: true, remote: 'allow' },
})

defineOp({
  name: 'mcp_call',
  title: 'Call any tool on an MCP server',
  description:
    'Call any tool, including ones that change something, on a server whose plugin opened it to sessions '
    + '(`sessions: all` in mcp_servers). From this Mac only. If the answer times out the tool may still have '
    + 'run: check before calling a write again.',
  input: { server: SERVER, tool: TOOL, arguments: ARGUMENTS, timeout_ms: TIMEOUT },
  bind: { method: 'POST', path: '/api/mcp/servers/:server/call' },
  timeoutMs: OP_TIMEOUT_MS,
  tags: { readonly: false, remote: 'deny' },
})
