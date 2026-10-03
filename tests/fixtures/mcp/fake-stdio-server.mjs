#!/usr/bin/env node
/**
 * A stdio MCP server for tests of src/core/mcp-servers/. Low-level `Server` on purpose: it
 * answers exactly what a test scripts, including answers a real SDK server would refuse to send
 * (a structured result that breaks its own outputSchema).
 *
 * Env knobs:
 *   FAKE_MCP_LOG            append one JSON line per event (start, list, call) to this file
 *   FAKE_MCP_START_DELAY_MS wait this long before answering anything (a slow start)
 *   FAKE_MCP_EXIT_AT_START  print it to stderr and exit 3 before connecting
 *   FAKE_MCP_PAGE_SIZE      tools/list page size (default: all on one page)
 *   FAKE_MCP_ENV_KEYS       comma list of env keys the `env` tool reports
 *
 * Tools: echo (ro), slow {ms} (ro), env (ro), fail (ro, isError), mismatch (ro, breaks its
 * outputSchema), note_write (rw), wipe (rw, destructive), drop (ro, exits mid-call),
 * add_tool {name} (rw, sends tools/list_changed), and any extra `pad_<n>` tools FAKE_MCP_PAD adds.
 */
import fs from 'node:fs'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js'

const logFile = process.env.FAKE_MCP_LOG
const record = (event) => {
  if (logFile) fs.appendFileSync(logFile, `${JSON.stringify({ pid: process.pid, at: Date.now(), ...event })}\n`)
}

if (process.env.FAKE_MCP_EXIT_AT_START) {
  process.stderr.write(`${process.env.FAKE_MCP_EXIT_AT_START}\n`)
  process.exit(3)
}

const ro = { readOnlyHint: true }
const tools = [
  { name: 'echo', description: 'Echo the arguments back.\nSecond line.', annotations: ro, inputSchema: { type: 'object' } },
  { name: 'slow', description: 'Answer after `ms`.', annotations: ro, inputSchema: { type: 'object', properties: { ms: { type: 'number' } } } },
  { name: 'env', description: 'Report selected env keys.', annotations: ro, inputSchema: { type: 'object' } },
  { name: 'fail', description: 'Answer with isError.', annotations: ro, inputSchema: { type: 'object' } },
  {
    name: 'mismatch',
    description: 'A structured answer that breaks its own outputSchema.',
    annotations: ro,
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object', properties: { count: { type: 'number' } }, required: ['count'] },
  },
  { name: 'note_write', description: 'Pretend to write a note.', annotations: { readOnlyHint: false }, inputSchema: { type: 'object' } },
  { name: 'wipe', description: 'Pretend to delete everything.', annotations: { destructiveHint: true }, inputSchema: { type: 'object' } },
  { name: 'drop', description: 'Exit in the middle of the call.', annotations: ro, inputSchema: { type: 'object' } },
  { name: 'add_tool', description: 'Add a tool and announce it.', inputSchema: { type: 'object', properties: { name: { type: 'string' } } } },
]
for (let i = 0; i < Number(process.env.FAKE_MCP_PAD ?? 0); i++) {
  tools.push({ name: `pad_${i}`, description: `Padding tool ${i}`, annotations: ro, inputSchema: { type: 'object' } })
}

const server = new Server({ name: 'fake-mcp', version: '1.2.3' }, { capabilities: { tools: { listChanged: true } } })
const text = (value) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] })

server.setRequestHandler(ListToolsRequestSchema, async (request) => {
  record({ kind: 'list', cursor: request.params?.cursor ?? null })
  const size = Number(process.env.FAKE_MCP_PAGE_SIZE ?? 0) || tools.length
  const start = Number(request.params?.cursor ?? 0)
  const page = tools.slice(start, start + size)
  const next = start + size < tools.length ? String(start + size) : undefined
  return { tools: page, ...(next ? { nextCursor: next } : {}) }
})

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params
  record({ kind: 'call', tool: name, args })
  switch (name) {
    case 'echo': return text({ echoed: args })
    case 'slow':
      await new Promise((resolve) => setTimeout(resolve, Number(args.ms ?? 1000)))
      return text({ slept: Number(args.ms ?? 1000) })
    case 'env': {
      const keys = String(process.env.FAKE_MCP_ENV_KEYS ?? '').split(',').filter(Boolean)
      return text(Object.fromEntries(keys.map((key) => [key, process.env[key] ?? null])))
    }
    case 'fail': return { ...text({ error: 'channel_not_found', message: 'No such channel' }), isError: true }
    case 'mismatch': return { ...text('{"count":"many"}'), structuredContent: { count: 'many' } }
    case 'note_write': return text({ written: true })
    case 'wipe': return text({ wiped: true })
    case 'drop':
      process.stderr.write('fake-mcp: dropping on purpose\n')
      setTimeout(() => process.exit(7), 10)
      return new Promise(() => {})
    case 'add_tool':
      tools.push({ name: String(args.name ?? 'added'), description: 'Added at runtime', annotations: ro, inputSchema: { type: 'object' } })
      await server.sendToolListChanged()
      return text({ added: true })
    default:
      throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${name}`)
  }
})

const delay = Number(process.env.FAKE_MCP_START_DELAY_MS ?? 0)
if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
record({ kind: 'start' })
await server.connect(new StdioServerTransport())
