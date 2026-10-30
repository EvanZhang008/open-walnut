/**
 * Ratchet: every field an op accepts is in the schema its MCP tool advertises.
 *
 * 2026-10-29, Main's reflection: the letter re-check told sessions to settle a letter with
 * human_inbox_mark `settled`, and Main's MCP tool showed only read/pinned/archived, so it fell
 * back to the CLI. The source schema had the field; Main's MCP server was a process started
 * before the deploy that added it (a session's tool list is read once, when it starts). This
 * pins the part a build can break: the tool list built from the registry carries exactly each
 * op's input fields, and no handler reads an argument its input does not declare (zod strips
 * it, and the MCP client refuses it before the call).
 */
import { describe, it, expect } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createWalnutMcpServer } from '../../src/mcp/server.js'
import { listOps } from '../../src/ops/index.js'

async function advertised(): Promise<Map<string, Set<string>>> {
  const mcp = createWalnutMcpServer({ apiBase: 'http://127.0.0.1:9' })
  const client = new Client({ name: 'ratchet', version: '1' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await Promise.all([mcp.connect(b), client.connect(a)])
  try {
    const out = new Map<string, Set<string>>()
    let cursor: string | undefined
    do {
      const page = await client.listTools(cursor ? { cursor } : {})
      for (const t of page.tools) out.set(t.name, new Set(Object.keys((t.inputSchema as { properties?: object }).properties ?? {})))
      cursor = page.nextCursor
    } while (cursor)
    return out
  } finally {
    await client.close().catch(() => {})
    await mcp.close().catch(() => {})
  }
}

/** The keys a handler destructures from its first argument: `async ({ a, b: c, ...rest }, call)`. */
function destructured(handler: (...args: never[]) => unknown): string[] | null {
  const src = handler.toString()
  const m = /^\s*(?:async\s*)?(?:function\s*\w*\s*)?\(\s*\{([^}]*)\}/.exec(src)
  if (!m) return null
  return m[1].split(',').map((p) => p.trim()).filter((p) => p && !p.startsWith('...'))
    .map((p) => p.split(/[:=]/)[0].trim()).filter(Boolean)
}

describe('MCP tool schemas carry every op field', () => {
  it('each tool advertises exactly its op\'s input fields', async () => {
    const tools = await advertised()
    const ops = listOps()
    expect(ops.length).toBeGreaterThan(50)
    const wrong: string[] = []
    for (const op of ops) {
      const got = tools.get(op.name)
      if (!got) { wrong.push(`${op.name}: not advertised`); continue }
      const want = new Set(Object.keys(op.input ?? {}))
      const missing = [...want].filter((k) => !got.has(k))
      const extra = [...got].filter((k) => !want.has(k))
      if (missing.length || extra.length) wrong.push(`${op.name}: missing [${missing.join(', ')}] extra [${extra.join(', ')}]`)
    }
    expect(wrong).toEqual([])
    // The field this ratchet was born for.
    expect([...(tools.get('human_inbox_mark') ?? [])]).toContain('settled')
  })

  it('no handler reads an argument its input does not declare', () => {
    const wrong: string[] = []
    for (const op of listOps()) {
      if (!op.handler) continue
      const keys = destructured(op.handler as (...args: never[]) => unknown)
      if (!keys) continue
      const declared = new Set(Object.keys(op.input ?? {}))
      const unknown = keys.filter((k) => !declared.has(k))
      if (unknown.length) wrong.push(`${op.name}: ${unknown.join(', ')}`)
    }
    expect(wrong).toEqual([])
  })
})
