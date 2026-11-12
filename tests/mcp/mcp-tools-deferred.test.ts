/**
 * No Walnut MCP server makes Claude Code load its tool schemas up front: every tool is listed by
 * name and its schema is loaded when the model asks for it (ToolSearch).
 *
 * 2026-11-12: the hub's `walnut mcp` marked all 174 ops `anthropic/alwaysLoad`, about 503 KB of
 * schemas (some 125K tokens) in the system prompt of Main and every ask, on every request. Main's
 * context came back to 242K right after each compaction and it compacted three times in three
 * minutes against a 250K window. The host server never set it (src/providers/walnut-mcp-stdio.ts).
 *
 * Pinned: no tool of the hub server (full, read-only, core) carries the flag, and no file in src/
 * sets it, so a new server or a new tool cannot bring it back.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createWalnutMcpServer, type McpOptions } from '../../src/mcp/server.js'

async function listTools(options: McpOptions) {
  // tools/list needs no API: nothing is called.
  const mcp = createWalnutMcpServer({ apiBase: 'http://127.0.0.1:9', ...options })
  const client = new Client({ name: 'deferred-test', version: '1' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await Promise.all([mcp.connect(b), client.connect(a)])
  try {
    return (await client.listTools()).tools
  } finally {
    await client.close().catch(() => {})
    await mcp.close().catch(() => {})
  }
}

describe('Walnut MCP tools load on demand', () => {
  it.each([
    ['full', {}],
    ['read-only', { readonly: true }],
    ['core', { core: true }],
  ] as const)('the hub server (%s) lists no tool Claude Code would load up front', async (_name, options) => {
    const tools = await listTools(options)
    expect(tools.length).toBeGreaterThan(0)
    const upFront = tools.filter((t) => (t._meta as Record<string, unknown> | undefined)?.['anthropic/alwaysLoad'] === true).map((t) => t.name)
    expect(upFront).toEqual([])
  })

  it('no source file sets anthropic/alwaysLoad', () => {
    const root = path.resolve(import.meta.dirname, '../../src')
    const hits: string[] = []
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (/\.(ts|tsx|mjs|cjs|js)$/.test(e.name)) {
          const text = fs.readFileSync(p, 'utf8')
          if (/['"]anthropic\/alwaysLoad['"]\s*\]?\s*:\s*true/.test(text)) hits.push(path.relative(root, p))
        }
      }
    }
    walk(root)
    expect(hits).toEqual([])
  })
})
