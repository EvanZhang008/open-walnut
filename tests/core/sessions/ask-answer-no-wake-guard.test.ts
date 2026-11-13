/**
 * An answer for the user (task_send answers_ask) never starts work a task is not doing (2026-11-06,
 * the org reflection: a VP answered the ask of a task whose session had stopped, and within 90 s it
 * woke, pushed two commits, edited an installed plugin copy and armed a second trigger).
 *
 *  1. The gate itself (ask-answer.ts answerReach): only an open task with a live CLI is delivered to.
 *  2. Every path that takes an answers_ask, enumerated from the source: a NEW file reading the flag
 *     fails here until it is listed with how it keeps the rule.
 *  3. Every function that delivers a message about an answered ask asks the gate first.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { answerReach } from '../../../src/core/sessions/ask-answer.js'

const ROOT = path.resolve(__dirname, '../../..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
function srcFiles(dir = 'src'): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`
    if (e.isDirectory()) out.push(...srcFiles(rel))
    else if (/\.(ts|tsx|mjs|cjs)$/.test(e.name)) out.push(rel)
  }
  return out
}
/** Code without comments, so a mention in a doc line is no path. */
const code = (rel: string) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

describe('the gate', () => {
  const s = (process_status: 'running' | 'idle' | 'stopped' | 'error', archived = false) => ({ process_status, archived })
  it('delivers only to an open task with a live CLI', () => {
    expect(answerReach({ phase: 'NEED_ACTION' }, [s('idle')])).toEqual({ wakes: true })
    expect(answerReach({ phase: 'IN_PROGRESS' }, [s('running')])).toEqual({ wakes: true })
    expect(answerReach({ phase: 'NEED_ACTION' }, [s('stopped')])).toEqual({ wakes: false, why: 'stopped' })
    expect(answerReach({ phase: 'NEED_ACTION' }, [s('error')])).toEqual({ wakes: false, why: 'stopped' })
    expect(answerReach({ phase: 'NEED_ACTION' }, [s('idle', true)])).toEqual({ wakes: false, why: 'stopped' })
    expect(answerReach({ phase: 'NEED_ACTION' }, [])).toEqual({ wakes: false, why: 'stopped' })
    // A finished task is never reopened by an answer, even with its CLI still alive.
    expect(answerReach({ phase: 'COMPLETE' }, [s('idle')])).toEqual({ wakes: false, why: 'complete' })
    // The explicit way: force (its reason is checked where the message is admitted).
    expect(answerReach({ phase: 'COMPLETE' }, [s('stopped')], { force: true })).toEqual({ wakes: true })
  })
})

describe('every path that takes an answers_ask keeps the rule', () => {
  // Each file reading the flag, and what in it keeps a stopped or finished task from waking.
  const PATHS: Record<string, (c: string) => void> = {
    // The one entry point: checks, then the gate, and only then the message.
    'src/core/sessions/session-send-core.ts': (c) => {
      // The gate judges the session the answer would really reach (a reply's own routing).
      expect(c).toMatch(/prepareAskAnswer\([\s\S]*?replyDestinationOf\([\s\S]*?answerReach\([\s\S]*?commit\(\)[\s\S]*?delivery: 'recorded'[\s\S]*?if \(!reach\.wakes\)[\s\S]*?liveDelivery\([\s\S]*?performPlainSend\(/)
      // ...and the write keeps the check: only that session, still live, no Stop since.
      expect(c).toMatch(/export async function deliverToSession[\s\S]*?if \(opts\.liveOnly\)[\s\S]*?liveSendGuard\(/)
      expect(c).toMatch(/async function replyDestinationOf[\s\S]*?onwardAnswer\([\s\S]*?resolveReplyDestination\(/)
    },
    // The route maps the flag onto the entry point, nothing more.
    'src/web/routes/messages-v1.ts': (c) => { expect(c).toContain('answersAsk: b.answers_ask === true') },
    // The op's schema, and its outcome for an answer only recorded.
    'src/ops/work.ts': (c) => { expect(c).toContain("delivery === 'recorded'") },
    // The daemon's host never delivers one itself: while the server answers it leaves it to the
    // server, and while the server is away it refuses it as needing the server.
    'src/providers/offline-host-core.ts': (c) => {
      expect(c).toContain('if (args.answers_ask !== undefined) return null')
      expect(c).toMatch(/if \(args\.answers_ask === true\) return needsServer\(/)
    },
    // The checks and the gate itself (its refusals name the flag).
    'src/core/sessions/ask-answer.ts': (c) => { expect(c).toContain('export function answerReach(') },
    // Prompt text only (the default org instructions name the flag).
    'src/core/org/core-instructions.ts': () => {},
    // Prompt text only: the approvals-off line names answers_ask as the way to settle an outward ask.
    'src/core/sessions/reply-language-context.ts': (c) => { expect(c).not.toMatch(/answers_ask\s*:|answersAsk\s*:/) },
    // Op text only: task_ask_answer_withdraw names the answers it takes back; it delivers no answer.
    'src/ops/tasks.ts': (c) => { expect(c).not.toMatch(/answers_ask\s*:|answersAsk\s*:/) },
  }

  it('no file reads the flag that is not listed here', () => {
    const readers = srcFiles().filter((f) => /answers_ask|answersAsk/.test(code(f))).sort()
    expect(readers, 'a new path takes answers_ask: gate it with ask-answer.ts answerReach (or leave it to the server), then list it here').toEqual(Object.keys(PATHS).sort())
  })

  for (const [file, check] of Object.entries(PATHS)) {
    it(file, () => check(code(file)))
  }
})

describe('the sender reads what happened', () => {
  it('withdraw_ask keeps its meaning through the op, route, core and offline host', async () => {
    await import('../../../src/ops/index.js')
    const { getOp } = await import('../../../src/ops/registry.js')
    expect(getOp('task_send')!.input.withdraw_ask).toBeDefined()
    expect(code('src/web/routes/messages-v1.ts')).toContain('withdrawAsk: b.withdraw_ask === true')
    const core = code('src/core/sessions/session-send-core.ts')
    expect(core).toMatch(/input\.withdrawAsk && !input\.answersAsk[\s\S]*?throw new SendError/)
    expect(core).toMatch(/prepareAskAnswer\([\s\S]*?withdraw: input\.withdrawAsk === true/)
    const offline = code('src/providers/offline-host-core.ts')
    expect(offline).toContain('if (args.withdraw_ask !== undefined) return null')
    expect(offline).toContain("if (args.withdraw_ask === true && args.answers_ask !== true) return fail('bad_request'")
    expect(offline).toMatch(/args\.answers_ask === true\) return needsServer\(/)
  })

  it('an answer only recorded says it was not delivered, and how to have the task act', async () => {
    await import('../../../src/ops/index.js')
    const { getOp } = await import('../../../src/ops/registry.js')
    const op = getOp('task_send')!
    const out = op.mapResult!({ body: { delivery: 'recorded', notWoken: 'stopped', targetTaskId: 'mtask-0001' }, args: { to: 'mtask-0001', answers_ask: true } } as never) as Record<string, unknown>
    expect(String(out.outcome)).toContain('Not delivered: the task is not running')
    expect(String(out.next)).toContain('task_start mtask-0001')
    const done = op.mapResult!({ body: { delivery: 'recorded', notWoken: 'complete', targetTaskId: 'mtask-0002' }, args: { to: 'mtask-0002', answers_ask: true } } as never) as Record<string, unknown>
    expect(String(done.outcome)).toContain('the task is COMPLETE')
  })
})

describe('every delivery about an answered ask asks the gate', () => {
  const SEND = /\b(?:sendMessageToSession|deliverToSession|performPlainSend|enqueueMessage)\(/
  it('in ask-answer.ts, each function that sends a message calls answerReach first', () => {
    const parts = code('src/core/sessions/ask-answer.ts').split(/\n(?=export (?:async )?function )/)
    const senders = parts.filter((p) => SEND.test(p))
    expect(senders.length).toBeGreaterThan(0)
    for (const p of senders) {
      const name = /function (\w+)/.exec(p)?.[1]
      expect(p.indexOf('answerReach('), `${name} sends without the gate`).toBeGreaterThan(-1)
      expect(p.indexOf('answerReach('), `${name} sends before the gate`).toBeLessThan(p.search(SEND))
      expect(p, `${name} sends without binding the check to the write`).toContain('liveSendGuard(')
    }
  })

  it('a file using the ask-answer module to send asks the gate too', () => {
    const users = srcFiles().filter((f) => f !== 'src/core/sessions/ask-answer.ts' && /sessions\/ask-answer\.js|\.\/ask-answer\.js/.test(code(f)))
    for (const f of users) {
      const c = code(f)
      if (/prepareAskAnswer\(/.test(c)) expect(c, `${f} prepares an answer without the gate`).toContain('answerReach(')
    }
  })
})
