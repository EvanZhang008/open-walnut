/**
 * Ratchet: every op call that crosses to the Walnut server carries a call id, and every
 * write op makes its writes where the call id can dedup them (src/lib/op-call-id.ts).
 *
 * 2026-11-04: task_send came back `hub_timeout` though its message was delivered; the
 * caller could resend (two copies) or believe a delivered message lost. The fix is one
 * id per call, chosen by the caller, that the server runs at most once and op_result
 * reads. It holds only while EVERY client sends one and every write goes through the
 * op executor's self-calls, so this test enumerates both from the source and the
 * registry: a new client, a new executeOp caller, or a write op that writes some other
 * way fails here until it carries the id or is listed with its reason.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { listOps } from '../../src/ops/index.js'

const ROOT = path.resolve(__dirname, '../..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8')

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name)
    if (e.isDirectory()) walk(rel, out)
    else if (/\.(ts|tsx)$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(rel)
  }
  return out
}

const SRC = walk('src')

/**
 * Places that build a gateway `tools.call` request. Each must carry `callId` within its
 * statement, or name only reads (a read runs again freely; nothing to dedup).
 */
const CALL_SITE = /op:\s*'tools\.call'|op = 'tools\.call'|request\('tools\.call'|gateway\(socketPath, sid, 'tools\.call'/g

/** A site whose window names one of these reads only reads (a wait, a check, the manual). */
const READ_SITES: Array<{ file: string; marker: string; why: string }> = [
  { file: 'src/providers/wn-cli.ts', marker: 'trigger_template_check', why: 'a trigger check reads a template\'s answer' },
  { file: 'src/providers/wn-cli.ts', marker: "name: opName, args: { id: parsed.id }", why: 'walnut wait polls request_get / task_get' },
  { file: 'src/providers/wn-cli.ts', marker: "'request_get' : 'task_get'", why: 'walnut wait polls request_get / task_get' },
  { file: 'src/providers/daemon-source.ts', marker: "name: 'skill_read'", why: 'walnut guide reads the manual' },
  { file: 'src/providers/daemon-source.ts', marker: "'request_get' : 'task_get'", why: 'walnut wait polls request_get / task_get' },
]

/** Sites whose helper mints the id for every call it sends (checked below). */
const MINTED_INSIDE: Array<{ file: string; marker: string; helper: RegExp }> = [
  { file: 'src/providers/plugin-job-harness.ts', marker: "gateway(socketPath, sid, 'tools.call'", helper: /const callId = op === 'tools\.call'[\s\S]{0,200}if \(callId\) args = \{ \.\.\.args, callId \}/ },
]

describe('every client sends a call id with tools.call', () => {
  it('each request site carries callId or is a listed read', () => {
    const missing: string[] = []
    let sites = 0
    for (const file of SRC) {
      const text = read(file)
      for (const m of text.matchAll(CALL_SITE)) {
        sites += 1
        let statement: string
        if (m[0].startsWith('op = ')) {
          // The source twin sets `op` and then `args` in the same branch: up to the branch's end.
          const window = text.slice(m.index!, m.index! + 1500)
          const end = window.search(/\}\s*else\b/)
          statement = end === -1 ? window : window.slice(0, end)
        } else {
          const window = text.slice(m.index!, m.index! + 700)
          statement = window.slice(0, Math.max(window.indexOf(';\n'), window.indexOf('\n\n'), 200))
        }
        if (/callId/.test(statement)) continue
        if (READ_SITES.some((r) => r.file === file && statement.includes(r.marker))) continue
        const minted = MINTED_INSIDE.find((r) => r.file === file && statement.includes(r.marker))
        if (minted && minted.helper.test(text)) continue
        const line = text.slice(0, m.index!).split('\n').length
        missing.push(`${file}:${line}`)
      }
    }
    expect(sites).toBeGreaterThan(8)
    expect(missing, 'a tools.call request without a call id: send callId (src/lib/op-call-id.ts) or list it as a read').toEqual([])
  })

  it('the walnut CLI\'s main call and the MCP server send the id beside the op name', () => {
    const cli = read('src/providers/wn-cli.ts')
    expect(cli).toMatch(/name: parsed\.name,[\s\S]{0,200}callId: callId \|\| \(callId = newCallId\(\)\)/)
    const mcp = read('src/providers/walnut-mcp-stdio.ts')
    expect(mcp.match(/deps\.request\('tools\.call'[^\n]*callId/g)?.length).toBe(2)
  })
})

/**
 * Every caller of executeOp outside the executor: `callId` when it stands for a caller that
 * can lose an answer and call again, else why not.
 */
const EXECUTE_OP_CALLERS: Record<string, 'callId' | string> = {
  'src/core/peers/capability-router.ts': 'callId',
  'src/core/leader/backup-gateway.ts': 'callId',
  'src/commands/tools.ts': 'callId',
  'src/commands/mcp-client.ts': 'callId',
  'src/mcp/tools.ts': 'callId',
  'src/core/offline-handover.ts': 'callId',
  'src/core/offline-merge/apply-v2.ts': 'callId',
  'src/commands/guide.ts': 'reads the manual (skill_read)',
  'src/commands/wait.ts': 'polls request_get / task_get, reads',
  'src/core/tools/read-only.ts': 'runs readonly ops only',
  'src/core/time-tracking/timeline/core-sources.ts': 'reads the calendar (calendar_query)',
  'src/commands/approve.ts': 'a loop on this machine whose polls are writes (approval_wait): each poll must run, and the request itself is made once',
  'src/commands/pass.ts': 'a loop on this machine whose polls are writes (password_wait): each poll must run, and the request itself is made once',
  'src/commands/browser.ts': 'a loop on this machine over its own browser ops; a lost answer ends the command',
  'src/web/routes/actions-v1.ts': 'a person\'s action inside this server: no hub between, nothing lost on the way',
  'src/core/human-inbox/item-execution.ts': 'a letter\'s planned action, run once by the item ledger (item-ledger.ts)',
  'src/core/plugins/server-api.ts': 'a plugin\'s own walnut.ops.call inside this server process',
}

describe('every executeOp caller is classified', () => {
  it('no caller is missing from the list, and the ones marked callId pass one at every call', () => {
    const found = new Map<string, number>()
    for (const file of SRC) {
      if (file === path.join('src', 'ops', 'executor.ts')) continue
      const text = read(file)
      const calls = [...text.matchAll(/\bexecuteOp\(/g)]
      if (!calls.length) continue
      found.set(file, calls.length)
      if (EXECUTE_OP_CALLERS[file] !== 'callId') continue
      for (const m of calls) {
        const window = text.slice(m.index!, m.index! + 400)
        const line = text.slice(0, m.index!).split('\n').length
        expect(/callId|recordCall\(/.test(window), `${file}:${line} must pass the call's id`).toBe(true)
      }
    }
    const unlisted = [...found.keys()].filter((f) => !(f in EXECUTE_OP_CALLERS))
    expect(unlisted, 'a new executeOp caller: pass callId (src/lib/op-call-id.ts) or list it here with why not').toEqual([])
    const stale = Object.keys(EXECUTE_OP_CALLERS).filter((f) => !found.has(f))
    expect(stale, 'listed callers that no longer call executeOp').toEqual([])
  })
})

describe('every write op writes through the executor\'s self-calls', () => {
  it('a bound write op uses a write method; a handler write op makes its writes with `call`', () => {
    const bad: string[] = []
    for (const op of listOps({ includeDeprecated: true })) {
      if (op.tags.readonly) continue
      if (op.bind && (op.bind.method === 'GET' || op.bind.method === 'HEAD')) bad.push(`${op.name}: a write bound to ${op.bind.method}, which carries no op id`)
      if (op.handler) {
        const src = op.handler.toString()
        const head = /^(?:async\s*)?(?:function\s*\w*\s*)?\(([^)]*)\)|^(?:async\s+)?(\w+)\s*=>/.exec(src)
        const params = (head?.[1] ?? head?.[2] ?? '').split(',').map((p) => p.trim()).filter(Boolean)
        const callParam = params.length >= 2 ? params[params.length - 1].replace(/[^\w$]/g, '') : ''
        const body = src.slice(head ? head[0].length : 0)
        if (!callParam || !new RegExp(`\\b${callParam}\\b`).test(body)) bad.push(`${op.name}: its handler never uses its self-call parameter`)
      }
    }
    expect(bad, 'a write op that writes some other way cannot be deduped by its call id').toEqual([])
  })
})
