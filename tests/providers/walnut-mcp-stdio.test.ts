/**
 * `walnut mcp-server`: Walnut's ops as an MCP stdio server over the host daemon's
 * gateway socket (src/providers/walnut-mcp-stdio.ts).
 *
 * The handler tests pin the protocol answers; the e2e test runs the real CLI
 * entry (`runWalnutCli(['mcp-server'])`) as a child process against a fake
 * gateway socket, driven by the real MCP SDK client, so framing, the caller sid
 * and the large-payload spill are exercised end to end.
 */
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import {
  createWalnutMcpHandler, fileToolListCache, mcpListAnswerMs, mcpToolOf, negotiateProtocol, sweepToolListCache,
  MCP_LIST_ANSWER_MS, MCP_PROTOCOL_VERSIONS, type ToolListCache,
} from '../../src/providers/walnut-mcp-stdio.js'
import { GATEWAY_INLINE_ARGS_MAX_BYTES } from '../../src/providers/tool-args-source.js'
import type { GatewayResponse } from '../../src/providers/gateway-core.js'

const ROOT = path.resolve(__dirname, '../..')
const formatError = (e: { code: string; message: string }) => [`walnut: ${e.code}: ${e.message}`]

describe('walnut mcp-server handler', () => {
  it('answers initialize with the client version it speaks, else its newest', () => {
    expect(negotiateProtocol('2025-06-18')).toBe('2025-06-18')
    expect(negotiateProtocol('1999-01-01')).toBe(MCP_PROTOCOL_VERSIONS[0])
    expect(negotiateProtocol(undefined)).toBe(MCP_PROTOCOL_VERSIONS[0])
  })

  it('a hub row with no schema (an older hub) still becomes a callable tool', () => {
    const t = mcpToolOf({ name: 'task_get', description: 'Get one task', signature: 'id', readonly: true })
    expect(t.inputSchema).toEqual({ type: 'object', additionalProperties: true })
    expect(t.description).toBe('Get one task\n\nArguments: id')
    expect(t.annotations).toEqual({ readOnlyHint: true })
    const s = mcpToolOf({ name: 'task_delete', description: 'd', inputSchema: { type: 'object' }, destructive: true })
    expect(s.description).toBe('d')
    expect(s.annotations).toEqual({ destructiveHint: true })
  })

  it('notifications get no answer; unknown methods get method-not-found', async () => {
    const handle = createWalnutMcpHandler({ request: async () => ({ ok: true, result: {} }), formatError })
    expect(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull()
    expect(await handle({ jsonrpc: '2.0', id: 9, method: 'nope' })).toMatchObject({ id: 9, error: { code: -32601 } })
    expect(await handle({ jsonrpc: '2.0', id: 10, method: 'ping' })).toEqual({ jsonrpc: '2.0', id: 10, result: {} })
  })

  it('a gateway error is a tool error carrying the op detail and the CLI lines', async () => {
    const handle = createWalnutMcpHandler({
      request: async () => ({ ok: false, error: { code: 'internal', message: 'boom', detail: { outcome: 'Refused' } } }),
      formatError,
    })
    const reply = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'task_get', arguments: { id: 'x' } } })
    const result = reply?.result as { isError?: boolean; content: Array<{ text: string }> }
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('"outcome":"Refused"')
    expect(result.content[0].text).toContain('walnut: internal: boom')
  })

  it('a daemon that does not answer is a tool error, never a hung call', async () => {
    const handle = createWalnutMcpHandler({ request: async () => { throw new Error('socket closed') }, formatError })
    const reply = await handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'task_get', arguments: {} } })
    expect((reply?.result as { isError?: boolean }).isError).toBe(true)
    const list = await handle({ jsonrpc: '2.0', id: 3, method: 'tools/list' })
    expect(list).toMatchObject({ id: 3, error: { code: -32603 } })
  })

  it('a short list (the Mac away, an older hub) is answered, completed later, and the client told', async () => {
    let calls = 0
    const notified: string[] = []
    const full = { ok: true as const, result: { ops: [{ name: 'task_get', inputSchema: { type: 'object' } }, { name: 'task_list', inputSchema: { type: 'object' } }] } }
    const handle = createWalnutMcpHandler({
      formatError,
      listRetryMs: 5,
      notify: (m) => notified.push(m),
      request: async (_op, args) => {
        if (args.report) return { ok: true, result: { recorded: true } }
        calls++
        if (calls === 1) return { ok: false, error: { code: 'hub_unreachable', message: 'no primary' } }
        if (calls === 2) return { ok: true, result: { ops: [{ name: 'task_get', signature: 'id' }] } }
        return full
      },
    })
    const init = await handle({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {} })
    expect((init?.result as { capabilities: { tools: { listChanged: boolean } } }).capabilities.tools.listChanged).toBe(true)
    const first = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    expect(first).toEqual({ jsonrpc: '2.0', id: 1, result: { tools: [] } })
    const deadline = Date.now() + 2000
    while (notified.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5))
    expect(notified).toEqual(['notifications/tools/list_changed'])
    expect(calls).toBe(3)
    const second = await handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    expect((second?.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name)).toEqual(['task_get', 'task_list'])
    await handle({ jsonrpc: '2.0', id: 3, method: 'tools/list' })
    expect(calls).toBe(3)
  })

  /**
   * The class: a session's Walnut tools survive a restart of the server or the daemon. Claude Code
   * reads a list once and refreshes it only on list_changed, and takes no late answer to a list that
   * timed out (2026-11-22, the Mac's debug logs: "Failed to fetch tools: Request timed out", then
   * our `{"tools":[]}` 0.5 s late; sessions resumed at 09:49:12 by a restart read a list without
   * the 37 tools of plugins still loading, and kept it for the process's life).
   */
  describe('the tool list survives a restart of the server or the daemon', () => {
    const tool = (name: string) => ({ name, inputSchema: { type: 'object' } })
    const memCache = (kept: Record<string, unknown>[] | null = null): ToolListCache & { kept: Record<string, unknown>[] | null } => {
      const c = { kept, read: () => c.kept, write: (t: Record<string, unknown>[]) => { c.kept = t } }
      return c
    }
    const waitFor = async (cond: () => boolean) => {
      const deadline = Date.now() + 2000
      while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5))
    }
    const names = (reply: unknown) => ((reply as { result: { tools: Array<{ name: string }> } }).result.tools).map((t) => t.name)

    it('a list read while the hub loads its plugins (partial) is answered, asked again, and the client told', async () => {
      let calls = 0
      const notified: string[] = []
      const cache = memCache()
      const handle = createWalnutMcpHandler({
        formatError, listRetryMs: 60_000, partialRetryMs: 5, notify: (m) => notified.push(m), listCache: cache,
        request: async () => (++calls === 1
          ? { ok: true, result: { ops: [tool('task_get')], partial: true } }
          : { ok: true, result: { ops: [tool('task_get'), tool('slack_search')] } }),
      })
      expect(names(await handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))).toEqual(['task_get'])
      // A partial list is never kept as this session's list.
      expect(cache.kept).toBeNull()
      await waitFor(() => notified.length > 0)
      expect(notified).toEqual(['notifications/tools/list_changed'])
      expect(names(await handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' }))).toEqual(['task_get', 'slack_search'])
      expect(cache.kept?.map((t) => t.name)).toEqual(['task_get', 'slack_search'])
    })

    it('a process started while the hub is away lists what this session was last given, then the new list', async () => {
      let up = false
      const notified: string[] = []
      const cache = memCache([tool('task_get'), tool('task_send'), tool('slack_search')])
      const handle = createWalnutMcpHandler({
        formatError, listRetryMs: 5, notify: (m) => notified.push(m), listCache: cache,
        request: async () => (up ? { ok: true, result: { ops: [tool('task_get'), tool('task_send')] } }
          : { ok: false, error: { code: 'hub_unreachable', message: 'the Walnut server is away' } }),
      })
      expect(names(await handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))).toEqual(['task_get', 'task_send', 'slack_search'])
      up = true
      await waitFor(() => notified.length > 0)
      expect(notified).toEqual(['notifications/tools/list_changed'])
      expect(names(await handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' }))).toEqual(['task_get', 'task_send'])
      expect(cache.kept?.map((t) => t.name)).toEqual(['task_get', 'task_send'])
    })

    it('a short offline set (rows without a schema) does not replace the kept list', async () => {
      const cache = memCache([tool('task_get'), tool('task_send'), tool('slack_search')])
      const handle = createWalnutMcpHandler({
        formatError, listRetryMs: 60_000, notify: () => {}, listCache: cache,
        request: async () => ({ ok: true, result: { ops: [{ name: 'task_get', signature: 'id' }, { name: 'task_send', signature: 'to, text' }], offline: true } }),
      })
      expect(names(await handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))).toEqual(['task_get', 'task_send', 'slack_search'])
      expect(cache.kept?.map((t) => t.name)).toEqual(['task_get', 'task_send', 'slack_search'])
    })

    it('a partial list longer than the kept one keeps its fresh rows and gains the kept tools it lacks', async () => {
      // An upgrade added more core ops than the plugins hold: the partial list is the longer one.
      const cache = memCache([{ ...tool('task_get'), description: 'old' }, tool('slack_search')])
      const handle = createWalnutMcpHandler({
        formatError, listRetryMs: 60_000, partialRetryMs: 60_000, notify: () => {}, listCache: cache,
        request: async () => ({ ok: true, result: { ops: [{ ...tool('task_get'), description: 'new' }, tool('task_send'), tool('task_list')], partial: true } }),
      })
      const reply = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
      expect(names(reply)).toEqual(['task_get', 'task_send', 'task_list', 'slack_search'])
      expect((reply as { result: { tools: Array<{ description: string }> } }).result.tools[0].description).toBe('new')
    })

    it('a partial answer is asked for again soon, not at the slow pace', async () => {
      let calls = 0
      const notified: string[] = []
      const handle = createWalnutMcpHandler({
        formatError, listRetryMs: 60_000, partialRetryMs: 5, notify: (m) => notified.push(m),
        request: async () => (++calls === 1 ? { ok: true, result: { ops: [tool('task_get')], partial: true } } : { ok: true, result: { ops: [tool('task_get'), tool('slack_search')] } }),
      })
      await handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
      await waitFor(() => notified.length > 0)
      expect(notified).toEqual(['notifications/tools/list_changed'])
    })

    it('with nothing kept, a hub past the early answer gets [] at once, then exactly one list_changed', async () => {
      let release: (() => void) | undefined
      const notified: string[] = []
      const handle = createWalnutMcpHandler({
        formatError, listAnswerMs: 20, listRetryMs: 5, notify: (m) => notified.push(m),
        request: () => new Promise((resolve) => { release = () => resolve({ ok: true, result: { ops: [tool('task_get')] } }) }),
      })
      expect(names(await handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))).toEqual([])
      release?.()
      await waitFor(() => notified.length > 0)
      await new Promise((r) => setTimeout(r, 50))
      expect(notified).toEqual(['notifications/tools/list_changed'])
      expect(names(await handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' }))).toEqual(['task_get'])
    })

    it('a late answer that is partial is asked for again', async () => {
      let calls = 0
      let release: (() => void) | undefined
      const notified: string[] = []
      const handle = createWalnutMcpHandler({
        formatError, listAnswerMs: 20, listRetryMs: 60_000, partialRetryMs: 5, notify: (m) => notified.push(m),
        request: (_op, args) => (args.report ? Promise.resolve({ ok: true, result: { recorded: true } }) : ++calls === 1
          ? new Promise((resolve) => { release = () => resolve({ ok: true, result: { ops: [tool('task_get')], partial: true } }) })
          : Promise.resolve({ ok: true, result: { ops: [tool('task_get'), tool('slack_search')] } })),
      })
      await handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
      release?.()
      await waitFor(() => notified.length > 0)
      expect(calls).toBe(2)
      expect(names(await handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' }))).toEqual(['task_get', 'slack_search'])
    })

    /**
     * The class: every answer that gives the session fewer tools than its whole list (none; a partial
     * or offline list with nothing kept to fill it) is told to the hub once that list is here, so the
     * real-use monitor counts how often a session ran without them (usage-watch/gateway-record.ts).
     * An answer that gave it all it had (a whole list, the kept one) is never told.
     */
    describe('a session given fewer tools than its list is told to the hub once that list is here', () => {
      const run = async (opts: { kept?: Record<string, unknown>[]; first: (release: () => void) => Promise<GatewayResponse>; late?: GatewayResponse }) => {
        const reports: Array<Record<string, unknown>> = []
        const notified: string[] = []
        let calls = 0
        let release: () => void = () => {}
        const released = new Promise<void>((r) => { release = r })
        const handle = createWalnutMcpHandler({
          formatError, listAnswerMs: 20, listRetryMs: 5, partialRetryMs: 5, notify: (m) => notified.push(m),
          ...(opts.kept ? { listCache: memCache(opts.kept) } : {}),
          request: async (_op, args) => {
            if (args.report) { reports.push(args.report as Record<string, unknown>); return { ok: true, result: { recorded: true } } }
            if (++calls === 1) return opts.first(release)
            await released
            return opts.late ?? { ok: true, result: { ops: [tool('task_get'), tool('task_send'), tool('slack_search')] } }
          },
        })
        const first = names(await handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))
        release()
        await waitFor(() => notified.length > 0)
        if (!opts.kept) await waitFor(() => reports.length > 0)
        await new Promise((r) => setTimeout(r, 30))
        return { first, reports: reports.map((r) => r.short_list as Record<string, unknown>), notified }
      }

      it('none given (a hub past the early answer, nothing kept): told once, given 0 of the whole list', async () => {
        const r = await run({ first: async (release) => { await new Promise((res) => setTimeout(res, 60)); release(); return { ok: true, result: { ops: [tool('task_get'), tool('task_send'), tool('slack_search')] } } } })
        expect(r.first).toEqual([])
        expect(r.reports).toEqual([{ given: 0, full: 3, ms: expect.any(Number), why: 'slow' }])
      })

      it('none given (the hub away, nothing kept): told once the hub is back', async () => {
        const r = await run({ first: async () => ({ ok: false, error: { code: 'hub_unreachable', message: 'away' } }) })
        expect(r.first).toEqual([])
        expect(r.reports).toEqual([{ given: 0, full: 3, ms: expect.any(Number), why: 'away' }])
      })

      it('none given (the host daemon not answering, nothing kept): told as short', async () => {
        const r = await run({ first: async () => { throw new Error('connect ENOENT agent-gateway.sock') } })
        expect(r.first).toEqual([])
        expect(r.reports).toEqual([{ given: 0, full: 3, ms: expect.any(Number), why: 'short' }])
      })

      it('a partial list with nothing kept: told with what it had', async () => {
        const r = await run({ first: async () => ({ ok: true, result: { ops: [tool('task_get')], partial: true } }) })
        expect(r.first).toEqual(['task_get'])
        expect(r.reports).toEqual([{ given: 1, full: 3, ms: expect.any(Number), why: 'partial' }])
      })

      it('a short offline set with nothing kept: told with what it had', async () => {
        const r = await run({ first: async () => ({ ok: true, result: { ops: [{ name: 'task_get', signature: 'id' }, { name: 'task_send', signature: 'to, text' }], offline: true } }) })
        expect(r.first).toEqual(['task_get', 'task_send'])
        expect(r.reports).toEqual([{ given: 2, full: 3, ms: expect.any(Number), why: 'away' }])
      })

      it('the kept list given while the hub is away: never told', async () => {
        const r = await run({ kept: [tool('task_get'), tool('task_send'), tool('slack_search')], first: async () => ({ ok: false, error: { code: 'hub_unreachable', message: 'away' } }) })
        expect(r.first).toEqual(['task_get', 'task_send', 'slack_search'])
        expect(r.reports).toEqual([])
      })

      it('a whole first list, and a role\'s shorter whole list after a longer kept one: never told', async () => {
        const reports: unknown[] = []
        for (const kept of [undefined, [tool('task_get'), tool('task_send'), tool('slack_search'), tool('brief_read')]]) {
          const handle = createWalnutMcpHandler({
            formatError, listAnswerMs: 2_000, listRetryMs: 5, notify: () => {}, ...(kept ? { listCache: memCache(kept) } : {}),
            request: async (_op, args) => {
              if (args.report) { reports.push(args.report); return { ok: true, result: { recorded: true } } }
              return { ok: true, result: { ops: [tool('task_get'), tool('task_send')] } }
            },
          })
          expect(names(await handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))).toEqual(['task_get', 'task_send'])
        }
        // A report would be sent while the whole list is taken, before the answer: none was.
        expect(reports).toEqual([])
      })

      it('a hub that does not take the word (an older one, or none) changes nothing for the session', async () => {
        const notified: string[] = []
        let calls = 0
        const handle = createWalnutMcpHandler({
          formatError, listAnswerMs: 20, listRetryMs: 5, notify: (m) => notified.push(m),
          request: async (_op, args) => {
            if (args.report) throw new Error('socket closed')
            return ++calls === 1 ? { ok: false, error: { code: 'hub_unreachable', message: 'away' } } : { ok: true, result: { ops: [tool('task_get')] } }
          },
        })
        expect(names(await handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))).toEqual([])
        await waitFor(() => notified.length > 0)
        expect(names(await handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' }))).toEqual(['task_get'])
      })
    })

    it('the early answer comes 2 s inside the client\'s own MCP_TIMEOUT when that is shorter', () => {
      expect(mcpListAnswerMs({})).toBe(MCP_LIST_ANSWER_MS)
      expect(mcpListAnswerMs({ MCP_TIMEOUT: '60000' })).toBe(MCP_LIST_ANSWER_MS)
      expect(mcpListAnswerMs({ MCP_TIMEOUT: '10000' })).toBe(8_000)
      expect(mcpListAnswerMs({ MCP_TIMEOUT: '1500' })).toBe(1_000)
      expect(mcpListAnswerMs({ MCP_TIMEOUT: 'soon' })).toBe(MCP_LIST_ANSWER_MS)
    })

    it('a hub slower than the client waits is answered before the client gives up, and its late list still lands', async () => {
      let release: (() => void) | undefined
      const notified: string[] = []
      const handle = createWalnutMcpHandler({
        formatError, listAnswerMs: 20, listRetryMs: 5, notify: (m) => notified.push(m), listCache: memCache([tool('task_get')]),
        request: () => new Promise((resolve) => { release = () => resolve({ ok: true, result: { ops: [tool('task_get'), tool('task_list')] } }) }),
      })
      const started = Date.now()
      expect(names(await handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))).toEqual(['task_get'])
      expect(Date.now() - started).toBeLessThan(1_000)
      release?.()
      await waitFor(() => notified.length > 0)
      expect(notified).toEqual(['notifications/tools/list_changed'])
      expect(names(await handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' }))).toEqual(['task_get', 'task_list'])
    })

    it('the kept list lives on disk per session, one file per list, and only in an owner-only directory', () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-mcp-lists-'))
      try {
        const dir = path.join(root, 'lists')
        const a = fileToolListCache(dir, 'sess-a')
        expect(a.read()).toBeNull()
        a.write([tool('task_get')])
        fileToolListCache(dir, 'sess-b').write([tool('task_get')])
        expect(fileToolListCache(dir, 'sess-a').read()).toEqual([tool('task_get')])
        expect(fs.readdirSync(dir).filter((n) => n.endsWith('.json'))).toHaveLength(1)
        expect(fs.statSync(dir).mode & 0o777).toBe(0o700)
        // A directory others can write to is never read: a tool description is what the model is told.
        fs.chmodSync(dir, 0o777)
        expect(fileToolListCache(dir, 'sess-a').read()).toBeNull()
        fs.chmodSync(dir, 0o700)
        // A file name never carries the session id as it is.
        expect(fs.readdirSync(dir).some((n) => n.includes('sess-'))).toBe(false)
        // A broken ref reads as no list, never a crash.
        const before = new Set(fs.readdirSync(dir))
        fileToolListCache(dir, 'sess-c').write([tool('task_get')])
        const ref = fs.readdirSync(dir).find((n) => !before.has(n))!
        expect(ref).toMatch(/^[0-9a-f]{16}\.ref$/)
        fs.writeFileSync(path.join(dir, ref), 'not a hash')
        expect(fileToolListCache(dir, 'sess-c').read()).toBeNull()
        expect(fileToolListCache(dir, 'sess-a').read()).toEqual([tool('task_get')])
      } finally { fs.rmSync(root, { recursive: true, force: true }) }
    })

    it('the sweep takes old refs, unfinished writes and lists no ref names; a list a ref just named is touched', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-mcp-sweep-'))
      try {
        const old = (file: string, ms: number) => { const t = new Date(Date.now() - ms); fs.utimesSync(path.join(dir, file), t, t) }
        fileToolListCache(dir, 'sess-a').write([tool('task_get')])
        const list = fs.readdirSync(dir).find((n) => n.endsWith('.json'))!
        // Another session's write of the same list refreshes it, so no sweep takes it as unnamed.
        old(list, 2 * 3600_000)
        fileToolListCache(dir, 'sess-b').write([tool('task_get')])
        expect(Date.now() - fs.statSync(path.join(dir, list)).mtimeMs).toBeLessThan(60_000)
        fs.writeFileSync(path.join(dir, 'x.json.1.tmp'), '[')
        fs.writeFileSync(path.join(dir, 'y.json.2.tmp'), '[')
        fs.writeFileSync(path.join(dir, '0123456789abcdef.json'), '[]')
        old('x.json.1.tmp', 2 * 3600_000)
        old('0123456789abcdef.json', 2 * 3600_000)
        for (const ref of fs.readdirSync(dir).filter((n) => n.endsWith('.ref'))) old(ref, 15 * 24 * 3600_000)
        sweepToolListCache(dir, Date.now())
        // Old refs gone, so their list is unnamed now but still fresh: kept until it is an hour old.
        expect(fs.readdirSync(dir).sort()).toEqual([list, 'y.json.2.tmp'].sort())
        old(list, 2 * 3600_000)
        sweepToolListCache(dir, Date.now())
        expect(fs.readdirSync(dir)).toEqual(['y.json.2.tmp'])
      } finally { fs.rmSync(dir, { recursive: true, force: true }) }
    })
  })

  it('a line that is not a JSON-RPC object is ignored, never a crash', async () => {
    const handle = createWalnutMcpHandler({ request: async () => ({ ok: true, result: {} }), formatError })
    expect(await handle(null as never)).toBeNull()
    expect(await handle([1] as never)).toBeNull()
  })

  it('arguments too big for the gateway line travel as a file the hub pulls, removed after', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-mcp-spill-'))
    let sent: Record<string, unknown> = {}
    let seenOnDisk = ''
    const handle = createWalnutMcpHandler({
      tmpDir,
      formatError,
      request: async (_op, args) => {
        sent = args
        seenOnDisk = fs.readFileSync(String(args.argsFile), 'utf-8')
        return { ok: true, result: { ok: 1 } }
      },
    })
    const big = 'x'.repeat(GATEWAY_INLINE_ARGS_MAX_BYTES + 10)
    await handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'human_inbox_send', arguments: { html: big } } })
    expect(sent.args).toBeUndefined()
    expect(JSON.parse(seenOnDisk)).toEqual({ html: big })
    expect(fs.readdirSync(tmpDir)).toEqual([])
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })
})

describe('walnut mcp-server e2e: real MCP client, real CLI entry, fake gateway socket', () => {
  let server: net.Server | undefined
  let dir: string | undefined
  afterEach(async () => {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()))
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  })

  it('lists the hub catalog and runs a call with shell-hostile text unchanged, as the session', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-mcp-e2e-'))
    const sock = path.join(dir, 'agent-gateway.sock')
    const seen: Array<{ op: string; sid: string; args: Record<string, unknown> }> = []
    server = net.createServer((c) => {
      let buf = ''
      c.on('data', (d) => {
        buf += d.toString()
        const nl = buf.indexOf('\n')
        if (nl === -1) return
        const req = JSON.parse(buf.slice(0, nl)) as { op: string; sid: string; args: Record<string, unknown> }
        seen.push(req)
        let resp: GatewayResponse
        if (req.op === 'tools.list') {
          resp = { ok: true, result: { ops: [{ name: 'task_update', title: 'Update', description: 'Update a task', readonly: false,
            inputSchema: { type: 'object', properties: { id: { type: 'string' }, description: { type: 'string' } }, required: ['id'] } }] } }
        } else {
          resp = { ok: true, result: { echoed: req.args.args } }
        }
        c.end(JSON.stringify(resp) + '\n')
      })
    })
    await new Promise<void>((r) => server!.listen(sock, () => r()))
    fs.chmodSync(sock, 0o600)

    const entry = path.join(dir, 'entry.ts')
    fs.writeFileSync(entry, `import { runWalnutCli } from ${JSON.stringify(path.join(ROOT, 'src/providers/wn-cli.ts'))}\nprocess.exit(await runWalnutCli(['mcp-server']))\n`)
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [entry],
      env: { ...process.env as Record<string, string>, WALNUT_AGENT_SOCKET: sock, WALNUT_SESSION_ID: 'sess-1234' },
      stderr: 'pipe',
    })
    const client = new Client({ name: 'test', version: '1' })
    await client.connect(transport)
    try {
      expect(client.getInstructions()).toContain('Walnut is the user')
      const { tools } = await client.listTools()
      expect(tools.map((t) => t.name)).toEqual(['task_update'])
      expect(tools[0].inputSchema.required).toEqual(['id'])
      const hostile = "run `walnut tools call` then $(date +%s); it's \"quoted\", $5, 100%, C:\\tmp, \\n, \u2705"
      const r = await client.callTool({ name: 'task_update', arguments: { id: 't1', description: hostile } })
      const body = JSON.parse((r.content as Array<{ text: string }>)[0].text) as { echoed: { description: string } }
      expect(body.echoed.description).toBe(hostile)
      expect(seen.map((s) => s.op)).toEqual(['tools.list', 'tools.call'])
      // It asks for its role's list (experiment mcp_tools_by_role): it can say how to reach the rest.
      expect(seen[0].args).toEqual({ schemas: true, listing: 'role' })
      for (const s of seen) expect(s.sid).toBe('sess-1234')
    } finally {
      await client.close()
    }
  }, 30_000)
})
