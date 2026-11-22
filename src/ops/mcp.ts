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
import { DOC_ANSWER_MAX_CHARS, clipText, pagedResult } from './doc-page.js'

const SERVER = z.string().min(1).max(64).describe('Server name, as `mcp_servers` lists it')
const TOOL = z.string().min(1).max(128).describe('Tool name, as `mcp_tools` lists it')
const ARGUMENTS = z.record(z.string(), z.unknown()).optional().describe('The tool\'s arguments (its inputSchema)')
const TIMEOUT = z.number().int().min(1).max(300_000).optional().describe('Deadline in ms (default: the server\'s, usually 60000)')
/** Long enough for a first start plus the call; the route enforces the real deadline. */
const OP_TIMEOUT_MS = 6 * 60_000

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {})
const clip = (v: unknown, max: number): string | undefined =>
  typeof v === 'string' && v ? clipText(v, max) : undefined
/** The head of a failed server's reason an agent reads in the list; `server` reads it whole. */
const ERROR_HEAD = 120
/** mcp_servers' cap: an agent's shell keeps about 10,000 characters. */
const SERVERS_MAX = 10_000

defineOp({
  name: 'mcp_servers',
  title: 'List MCP servers',
  description:
    'The MCP servers Walnut runs for its plugins: name, owner plugin, state (idle starts on first use, '
    + 'ready, starting, failed with the reason), tool count once known, and `sessions`: what you may call '
    + '(read-only: tools the server marks read-only, via mcp_read; all: also mcp_call from this Mac; '
    + 'none: plugin only). `server` narrows it to the servers whose name, title or plugin contains it, each '
    + 'whole. Listing never starts a server.',
  input: {
    server: z.string().min(1).max(64).optional().describe('Only servers whose name, title or owner plugin contains this (any case), each whole'),
  },
  bind: { method: 'GET', path: '/api/mcp/servers' },
  mapResult: ({ body, args }) => {
    const b = rec(body)
    const needle = typeof args.server === 'string' ? args.server.trim().toLowerCase() : ''
    if (!needle || !Array.isArray(b.servers)) return body
    const servers = b.servers.filter((one) => ['name', 'title', 'owner'].some((k) => String(rec(one)[k] ?? '').toLowerCase().includes(needle)))
    return { ...b, servers, ...(servers.length ? {} : { hint: `No MCP server matches "${args.server}"; mcp_servers with no server lists them all.` }) }
  },
  answer: {
    kind: 'content',
    max: SERVERS_MAX,
    // A row in a few facts; the reason a server failed is cut to its head (`server` reads it whole).
    shape: ({ result, args }) => {
      const r = rec(result)
      if (!Array.isArray(r.servers) || typeof args.server === 'string') return result
      let cut = 0
      const servers = r.servers.map((one) => {
        const s = rec(one)
        const error = typeof s.lastError === 'string' ? s.lastError : ''
        if (error.length > ERROR_HEAD) cut++
        return {
          name: s.name,
          ...(s.title && s.title !== s.name ? { title: s.title } : {}),
          owner: s.owner,
          state: s.state,
          sessions: s.sessions,
          ...(typeof s.toolCount === 'number' ? { toolCount: s.toolCount } : {}),
          ...(error ? { lastError: clip(error, ERROR_HEAD) } : {}),
        }
      })
      // The rows that fit; the rest by name (a plugin can register many).
      const kept: Record<string, unknown>[] = []
      // Room for the head fields, the note and the names left out.
      let used = 2_000
      for (const row of servers) {
        const n = JSON.stringify(row).length + 1
        if (kept.length && used + n > SERVERS_MAX) break
        kept.push(row)
        used += n
      }
      const left = servers.slice(kept.length).map((row) => String(row.name))
      return {
        ...r,
        count: servers.length,
        servers: kept,
        ...(left.length ? { moreServers: left } : {}),
        ...(cut || left.length
          ? { more: `${[cut ? `${cut} failure reason(s) cut to ${ERROR_HEAD} characters` : '', left.length ? `${left.length} server(s) by name only` : ''].filter(Boolean).join('; ')}: mcp_servers {"server":"<name>"} reads one whole.` }
          : {}),
      }
    },
  },
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
    + 'allows it, or the owning plugin\'s own op (a post that needs the user\'s approval goes through it). '
    + 'A long `text` answer comes in pages: `page.next` is the call that reads on (`offset`).',
  input: {
    server: SERVER, tool: TOOL, arguments: ARGUMENTS, timeout_ms: TIMEOUT,
    // Walnut's own paging of a long text answer, never passed to the tool (the route reads only tool, arguments, timeout_ms).
    offset: z.number().int().min(0).optional().describe('A long text answer from this many characters on (its page.next names it)'),
    section: z.string().max(200).optional().describe('A long Markdown text answer: only the part under this heading'),
  },
  bind: { method: 'POST', path: '/api/mcp/servers/:server/read' },
  timeoutMs: OP_TIMEOUT_MS,
  // A text answer is read in pages (doc-page.ts); a `data` (JSON) answer keeps the generic cut.
  answer: {
    kind: 'content',
    max: DOC_ANSWER_MAX_CHARS,
    shape: ({ result, args }) => pagedResult(result, 'text', args, (more) => `mcp_read ${JSON.stringify({ ...args, ...more })}`),
  },
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
  // Content, not a receipt: the answer is the tool's own answer, which is what the call is for.
  answer: { kind: 'content', max: 12_000 },
  tags: { readonly: false, remote: 'deny' },
})
