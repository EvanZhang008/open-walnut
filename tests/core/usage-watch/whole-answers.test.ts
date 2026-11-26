/**
 * The hub tells the recorder which calls an agent read as the op shaped it (capability-router.ts
 * handleToolsCall): a `_full` read and a call no session made are whole, in no size number
 * (record.ts OpCall.whole; the recorder's own test is in usage-watch.test.ts). This one drives the
 * real gateway path, the only place that decides it.
 *
 * 2026-11-24: watch uw-db7fdd83-d59 failed task_history on a 638,542-character answer and api on a
 * 44 MB one; in the transcripts of both hosts no agent read a Walnut answer over 21,000 characters
 * that day: the big ones were `_full` reads piped into files and script reads.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { closeUsageWatchStore, readHours, setUsageWatchFile } from '../../../src/core/usage-watch/store.js'
import { _resetUsageRecorderForTesting, flushUsage } from '../../../src/core/usage-watch/record.js'
import { handleGatewayCapability, type CapabilityRouterDeps } from '../../../src/core/peers/capability-router.js'
import { PeerThrottle } from '../../../src/core/peers/peer-throttle.js'
import { EXTERNAL_CALLER_SID } from '../../../src/providers/gateway-core.js'
import { definePluginOp, removePluginOps } from '../../../src/ops/index.js'

let dir: string
const SID = '7c2e9a10-4b6d-4f1e-8a3b-5d9c0e1f2a3b'
const BIG = 'x'.repeat(120_000)

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whole-answers-'))
  setUsageWatchFile(path.join(dir, 'usage-watch.sqlite'))
  _resetUsageRecorderForTesting(true)
})

afterEach(() => {
  removePluginOps('whole-answers-test')
  closeUsageWatchStore()
  setUsageWatchFile(null)
  _resetUsageRecorderForTesting(false)
  fs.rmSync(dir, { recursive: true, force: true })
})

const aggOf = (name: string) => {
  flushUsage()
  const rows = readHours(0, { kind: 'op', name }).map((r) => r.agg)
  return { calls: rows.reduce((n, a) => n + a.calls, 0), charsMax: Math.max(0, ...rows.map((a) => a.charsMax)), overLimit: rows.reduce((n, a) => n + a.overLimit, 0) }
}

describe('the gateway names the answers no agent read shaped', () => {
  it('a session\'s `_full` read and a caller with no session are whole; a session\'s shaped read is measured', async () => {
    definePluginOp('whole-answers-test', {
      name: 'whole_answers_big', title: 'Big answer', description: 'Answers a big text, as a long history read would.', input: {},
      handler: async () => ({ text: BIG }),
      tags: { readonly: true, remote: 'allow' },
    })
    const deps: CapabilityRouterDeps = { throttle: new PeerThrottle(), cloudMode: false }
    for (const [sid, args] of [[SID, { _full: true }], [EXTERNAL_CALLER_SID, {}]] as const) {
      const out = await handleGatewayCapability('tools.call', sid, { name: 'whole_answers_big', args, client: 'cli' }, 'clouddev', deps)
      expect(out.ok).toBe(true)
    }
    let a = aggOf('whole_answers_big')
    expect(a).toEqual({ calls: 2, charsMax: 0, overLimit: 0 })
    // A session's read without `_full` is shaped for it, and measured as it reads it.
    const shaped = await handleGatewayCapability('tools.call', SID, { name: 'whole_answers_big', args: {}, client: 'cli' }, 'clouddev', deps)
    expect(shaped.ok).toBe(true)
    a = aggOf('whole_answers_big')
    expect(a.calls).toBe(3)
    expect(a.charsMax).toBeGreaterThan(0)
    expect(a.charsMax).toBeLessThan(20_000)
  })

  // 2026-11-26: open_items read "over the limit" 103 times in a day; each was the compaction hook's
  // readback (`hook: "compact"`, 12,888 to 16,596 characters), which the op answers whole by its rule.
  it('an answer the op gives whole by its own rule is sized and never over a limit', async () => {
    definePluginOp('whole-answers-test', {
      name: 'whole_answers_hook', title: 'Hook answer', description: 'Answers a hook whole, as open_items answers a compaction hook.', input: { hook: z.string().optional() },
      answer: { kind: 'content', whole_for: (args) => args.hook !== undefined },
      handler: async () => ({ text: BIG }),
      tags: { readonly: true, remote: 'allow' },
    })
    const deps: CapabilityRouterDeps = { throttle: new PeerThrottle(), cloudMode: false }
    const hook = await handleGatewayCapability('tools.call', SID, { name: 'whole_answers_hook', args: { hook: 'compact' }, client: 'cli' }, 'clouddev', deps)
    expect(hook.ok).toBe(true)
    let a = aggOf('whole_answers_hook')
    expect(a.calls).toBe(1)
    expect(a.charsMax).toBeGreaterThan(BIG.length)
    expect(a.overLimit).toBe(0)
    // The same op's other calls are held to the surface: one that came out over it would count.
    const plain = await handleGatewayCapability('tools.call', SID, { name: 'whole_answers_hook', args: {}, client: 'cli' }, 'clouddev', deps)
    expect(plain.ok).toBe(true)
    a = aggOf('whole_answers_hook')
    expect(a).toMatchObject({ calls: 2, overLimit: 0 })
  })

  it('every reader of an op\'s whole_for rule goes through answersWhole', () => {
    // A new reader that tests the rule itself would again disagree with the recorder (the class above).
    const root = path.resolve(__dirname, '../../../src')
    const readers: string[] = []
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const f = path.join(d, e.name)
        if (e.isDirectory()) walk(f)
        else if (/\.tsx?$/.test(e.name) && /whole_for\s*(\?\.)?\(/.test(fs.readFileSync(f, 'utf8'))) readers.push(path.relative(root, f))
      }
    }
    walk(root)
    expect(readers).toEqual(['ops/answer.ts'])
    const calls = fs.readFileSync(path.join(root, 'core/peers/capability-router.ts'), 'utf8')
    expect(calls).toMatch(/answersWhole\(op, args\)/)
  })
})
