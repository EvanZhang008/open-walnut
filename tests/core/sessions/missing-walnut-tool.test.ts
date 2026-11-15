/**
 * A session that calls a Walnut tool its CLI does not offer is told once what to use instead, and
 * that a task which cannot write its state tells its lead, never the user
 * (src/core/sessions/missing-walnut-tool.ts). 2026-11-14: a router-made task kept calling the
 * retired router_work and asked the user to close it by hand.
 *
 * The guards below also fail when an instruction Walnut writes names a Walnut tool that does not
 * exist: every `mcp__walnut__<op>` in src/ and every tool the router's own profile allows is a live
 * op, or a retired one with its replacement named.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { getOp } from '../../../src/ops/index.js'
import { createMailTools } from '../../../src/integrations/mail/tools.js'
import {
  RETIRED_OPS, missingToolNotice, noteToolResult, refusedWalnutTool, resetMissingWalnutToolForTest,
} from '../../../src/core/sessions/missing-walnut-tool.js'
import { routerAreaProfile } from '../../../src/core/router/session-policy.js'

const REPO = path.resolve(__dirname, '../../..')
// The CLI's own words for a tool it does not offer (2026-11-14, session 8e924ea3).
const REFUSAL = (name: string) => `<tool_use_error>Error: No such tool available: mcp__walnut__${name}. Its MCP server 'walnut' is connected but does not offer this tool here. Continue without it.</tool_use_error>`

beforeEach(() => resetMissingWalnutToolForTest())

describe('refusedWalnutTool', () => {
  it('reads the op from the CLI refusal, and nothing from other results', () => {
    expect(refusedWalnutTool(REFUSAL('router_work'))).toBe('router_work')
    expect(refusedWalnutTool('{"taskId":"t1","saved":true}')).toBeNull()
    expect(refusedWalnutTool('Error: No such tool available: mcp__slack__post')).toBeNull()
    // Content blocks as the stream serializes them.
    expect(refusedWalnutTool(JSON.stringify([{ type: 'text', text: REFUSAL('router_item') }]))).toBe('router_item')
    // The same words inside a grep's or a log's output are data, not this session's refusal.
    expect(refusedWalnutTool(`log.txt:12: ${REFUSAL('router_work')}`)).toBeNull()
  })
})

describe('missingToolNotice', () => {
  it('a retired op names what replaces it, the CLI fallback and the lead route', () => {
    const text = missingToolNotice('router_work', getOp)
    expect(text).toContain('task_complete')
    expect(text).toContain('task_update')
    expect(text).toContain('walnut tools call')
    expect(text).toMatch(/tell your lead with task_send/)
    expect(text).toMatch(/never ask the user/)
  })

  it('a live op not offered here names its CLI form; an unknown one points at the op list', () => {
    expect(missingToolNotice('task_update', getOp)).toContain("walnut tools call task_update '<json>'")
    expect(missingToolNotice('task_completee', getOp)).toContain('walnut tools list')
  })
})

describe('noteToolResult', () => {
  const run = (data: Record<string, unknown>, sent: string[], slim = false) => noteToolResult({ isError: true, ...data }, {
    lookup: getOp, isSlim: async () => slim, send: async (_sid, text) => { sent.push(text) },
  })

  it('a router_work refusal in a task session sends one notice, once per session and tool', async () => {
    const sent: string[] = []
    expect(await run({ sessionId: 's1', taskId: 't1', result: REFUSAL('router_work') }, sent)).toBe(true)
    expect(await run({ sessionId: 's1', taskId: 't1', result: REFUSAL('router_work') }, sent)).toBe(false)
    expect(await run({ sessionId: 's1', taskId: 't1', result: REFUSAL('router_item') }, sent)).toBe(true)
    expect(await run({ sessionId: 's2', taskId: 't2', result: REFUSAL('router_work') }, sent)).toBe(true)
    expect(sent).toHaveLength(3)
    expect(sent[0]).toContain('task_complete')
  })

  it('ignores ordinary results, replayed events and slim sessions (no shell to fall back on)', async () => {
    const sent: string[] = []
    expect(await run({ sessionId: 's1', result: 'ok' }, sent)).toBe(false)
    expect(await run({ sessionId: 's1', result: REFUSAL('router_work'), replayed: true }, sent)).toBe(false)
    expect(await run({ sessionId: 's1', result: REFUSAL('router_work'), isError: false }, sent)).toBe(false)
    expect(await run({ sessionId: 's1', result: REFUSAL('router_work'), parentToolUseId: 'toolu_1' }, sent)).toBe(false)
    expect(await run({ sessionId: 'router', result: REFUSAL('router_route') }, sent, true)).toBe(false)
    expect(sent).toEqual([])
  })

  it('a failed delivery is not marked told, so the next refusal tries again', async () => {
    const deps = (send: () => Promise<void>) => ({ lookup: getOp, isSlim: async () => false, send })
    const data = { sessionId: 's9', result: REFUSAL('router_work'), isError: true }
    expect(await noteToolResult(data, deps(async () => { throw new Error('queue down') }))).toBe(false)
    expect(await noteToolResult(data, deps(async () => {}))).toBe(true)
  })
})

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sourceFiles(full))
    else if (/\.(ts|tsx|md)$/.test(entry.name)) out.push(full)
  }
  return out
}

describe('wiring', () => {
  it('the stream marks a failed and a replayed tool result, the leader listens, and a prompt-less resume builds one', () => {
    const runner = fs.readFileSync(path.join(REPO, 'src/providers/claude-code-session.ts'), 'utf-8')
    const emit = runner.slice(runner.indexOf('bus.emit(EventNames.SESSION_TOOL_RESULT'))
    expect(emit.slice(0, 900)).toMatch(/isError: true/)
    expect(emit.slice(0, 900)).toMatch(/replayed: true/)
    expect(runner).toMatch(/if \(!stored\) return this\.resumeOwedPrompt\(sessionId, stored\)/)
    expect(fs.readFileSync(path.join(REPO, 'src/web/server.ts'), 'utf-8')).toMatch(/startMissingWalnutTool\(\)/)
  })
})

describe('guard: Walnut never names a Walnut tool that does not exist', () => {
  it('every retired op is really gone, and its replacement names live ops', () => {
    for (const [name, instead] of Object.entries(RETIRED_OPS)) {
      expect(getOp(name), name).toBeUndefined()
      // The mail plugin's ops register with the plugin, not the core registry.
      const mailOps = new Set(createMailTools({} as never).map((tool) => tool.name))
      for (const op of instead.match(/\b[a-z]+_[a-z_]+\b/g) ?? []) expect(!!getOp(op) || mailOps.has(op), `${name} -> ${op}`).toBe(true)
    }
  })

  it('every mcp__walnut__<op> written under src/ is a live op or a retired one', () => {
    const offenders: string[] = []
    for (const file of sourceFiles(path.join(REPO, 'src'))) {
      for (const m of fs.readFileSync(file, 'utf-8').matchAll(/mcp__walnut__([a-z][a-z0-9_]*)/g)) {
        const name = m[1]
        if (!getOp(name) && !(name in RETIRED_OPS)) offenders.push(`${path.relative(REPO, file)}: ${name}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('every tool the router\'s own profile allows, and its prompt names, is a live op', () => {
    const profile = routerAreaProfile('personal')
    for (const tool of profile.allowedTools ?? []) {
      const name = tool.replace(/^mcp__walnut__/, '')
      expect(getOp(name), tool).toBeDefined()
      expect(getOp(name)?.deprecated, tool).toBeUndefined()
    }
    for (const name of profile.systemPrompt!.match(/\brouter_[a-z_]+\b/g) ?? []) {
      expect(profile.allowedTools, name).toContain(`mcp__walnut__${name}`)
    }
  })
})
