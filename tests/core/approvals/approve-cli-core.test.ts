/**
 * `walnut approve`'s shared loop (src/core/approvals/cli-core.ts), with scripted op answers:
 * it parses the same words on the Mac and on a host, keeps waiting through a dropped link,
 * stops on a definite refusal, withdraws the ask on Ctrl-C, and never exits 0 without an
 * approved answer.
 */
import { describe, it, expect } from 'vitest'
import { APPROVE_EXIT, parseApproveArgv, parseApproveDuration, runApprove, type OpCallResult } from '../../../src/core/approvals/cli-core.js'

describe('parseApproveArgv', () => {
  it('reads the words, the flags and the durations', () => {
    expect(parseApproveArgv(['Deploy', 'to', 'prod', '--biometric', '--timeout', '90s', '--detail=notes.md', '--json'])).toEqual({
      ok: true, what: 'Deploy to prod', biometric: true, timeoutMs: 90_000, detailFrom: 'notes.md', json: true,
    })
    expect(parseApproveArgv(['x', '--timeout=2h', '--from', 'release.sh'])).toMatchObject({ timeoutMs: 7_200_000, command: 'release.sh' })
    expect(parseApproveArgv(['--', '--not-a-flag'])).toMatchObject({ ok: true, what: '--not-a-flag' })
    expect(parseApproveDuration('10m')).toBe(600_000)
    expect(parseApproveDuration('1.5h')).toBe(5_400_000)
    expect(parseApproveDuration('soon')).toBeUndefined()
  })

  it('refuses what it cannot honour', () => {
    expect(parseApproveArgv([])).toMatchObject({ ok: false })
    expect(parseApproveArgv(['x', '--timeout', '5s'])).toMatchObject({ ok: false })
    expect(parseApproveArgv(['x', '--timeout', '3d'])).toMatchObject({ ok: false })
    expect(parseApproveArgv(['x', '--detail'])).toMatchObject({ ok: false })
    expect(parseApproveArgv(['x', '--yes'])).toMatchObject({ ok: false, error: 'unknown option --yes' })
    expect(parseApproveArgv(['y'.repeat(301)])).toMatchObject({ ok: false })
  })
})

const pending = { id: 'apr-1', status: 'pending', what: 'Deploy', mode: 'tap' }

function script(answers: Array<OpCallResult | (() => OpCallResult)>) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  let i = 0
  return {
    calls,
    call: async (name: string, args: Record<string, unknown>): Promise<OpCallResult> => {
      calls.push({ name, args })
      if (name === 'approval_request') return { ok: true, result: { approval: pending, waitToken: 'tok' } }
      if (name === 'approval_cancel') return { ok: true, result: { approval: { ...pending, status: 'canceled' } } }
      const a = answers[Math.min(i++, answers.length - 1)]
      return typeof a === 'function' ? a() : a
    },
  }
}

const args = { what: 'Deploy', biometric: false, timeoutMs: 60_000, json: false }
const io = (call: (n: string, a: Record<string, unknown>) => Promise<OpCallResult>, extra: Record<string, unknown> = {}) =>
  ({ call, say: () => undefined, out: () => undefined, sleep: async () => undefined, ...extra })

describe('runApprove', () => {
  it('waits through pending reads and a dropped link, then exits 0 only on approved', async () => {
    const s = script([
      { ok: true, result: { approval: pending } },
      { ok: false, message: 'Walnut request timed out' },
      { ok: true, result: { approval: { ...pending, status: 'approved', answer: { decision: 'approve', mode: 'tap', at: 'now', device: { name: 'iPhone', kind: 'iphone' } } }, used: true } },
    ])
    expect(await runApprove(args, io(s.call))).toBe(APPROVE_EXIT.approved)
    expect(s.calls.map((c) => c.name)).toEqual(['approval_request', 'approval_wait', 'approval_wait', 'approval_wait'])
    expect(s.calls[1].args).toMatchObject({ id: 'apr-1', token: 'tok', wait_ms: 12_000 })
    expect(s.calls[0].args).toMatchObject({ what: 'Deploy', mode: 'tap', timeout_ms: 60_000 })
  })

  it('denied is 1, expired and withdrawn are 2, a used answer is 1, a refusal is 3', async () => {
    const decided = (status: string) => script([{ ok: true, result: { approval: { ...pending, status } } }])
    expect(await runApprove(args, io(decided('denied').call))).toBe(APPROVE_EXIT.denied)
    expect(await runApprove(args, io(decided('expired').call))).toBe(APPROVE_EXIT.timeout)
    expect(await runApprove(args, io(decided('canceled').call))).toBe(APPROVE_EXIT.timeout)
    const used = script([{ ok: false, status: 400, code: 'approval_used', message: 'used' }])
    expect(await runApprove(args, io(used.call))).toBe(APPROVE_EXIT.denied)
    const bad = script([{ ok: false, status: 400, code: 'bad_token', message: 'no' }])
    expect(await runApprove(args, io(bad.call))).toBe(APPROVE_EXIT.error)
  })

  it('exits 3 when it cannot ask at all', async () => {
    const r = await runApprove(args, io(async () => ({ ok: false, message: 'Walnut server not running' })))
    expect(r).toBe(APPROVE_EXIT.error)
  })

  it('gives up at its own deadline when the server never answers', async () => {
    let t = 0
    const s = script([{ ok: false, message: 'hub_timeout' }])
    const r = await runApprove({ ...args, timeoutMs: 10_000 }, io(s.call, { now: () => (t += 5_000) }))
    expect(r).toBe(APPROVE_EXIT.timeout)
  })

  it('Ctrl-C withdraws the ask at once, mid-wait', async () => {
    let interrupt: () => void = () => undefined
    const s = {
      calls: [] as string[],
      call: async (name: string): Promise<OpCallResult> => {
        s.calls.push(name)
        if (name === 'approval_request') return { ok: true, result: { approval: pending, waitToken: 'tok' } }
        if (name === 'approval_wait') { setTimeout(() => interrupt(), 5); return new Promise(() => undefined) }
        return { ok: true, result: { approval: { ...pending, status: 'canceled' } } }
      },
    }
    const r = await runApprove(args, io(s.call, { onInterrupt: (fn: () => void) => { interrupt = fn; return () => undefined } }))
    expect(r).toBe(APPROVE_EXIT.interrupted)
    expect(s.calls).toEqual(['approval_request', 'approval_wait', 'approval_cancel'])
  })
})

describe('a lost link and Ctrl-C', () => {
  it('Ctrl-C during the pause after a dropped link withdraws at once', async () => {
    let interrupt: () => void = () => undefined
    const calls: string[] = []
    const call = async (name: string): Promise<OpCallResult> => {
      calls.push(name)
      if (name === 'approval_request') return { ok: true, result: { approval: pending, waitToken: 'tok' } }
      if (name === 'approval_wait') return { ok: false, message: 'Walnut request timed out' }
      return { ok: true, result: { approval: { ...pending, status: 'canceled' } } }
    }
    const sleep = () => { setTimeout(() => interrupt(), 5); return new Promise<void>(() => undefined) }
    const r = await runApprove(args, io(call, { sleep, onInterrupt: (fn: () => void) => { interrupt = fn; return () => undefined } }))
    expect(r).toBe(APPROVE_EXIT.interrupted)
    expect(calls).toEqual(['approval_request', 'approval_wait', 'approval_cancel'])
  })

  it('a server fault is the link, not a refusal: the CLI keeps waiting', async () => {
    const { opFailure } = await import('../../../src/commands/approve.js')
    expect(opFailure('Walnut API error (internal): boom')).toEqual({ ok: false, message: 'Walnut API error (internal): boom' })
    expect(opFailure('Walnut API error (leader_only): away').code).toBeUndefined()
    expect(opFailure('Walnut API error (approval_used): used')).toMatchObject({ status: 400, code: 'approval_used' })
  })
})

describe('a host CLI carries its test run', () => {
  it('rides WALNUT_TEST_RUN as testRun, and nothing without one', async () => {
    const { testRunArg } = await import('../../../src/providers/wn-cli.js')
    expect(testRunArg({ WALNUT_TEST_RUN: 'demo-1' } as NodeJS.ProcessEnv)).toEqual({ testRun: 'demo-1' })
    expect(testRunArg({} as NodeJS.ProcessEnv)).toEqual({})
    expect(testRunArg({ WALNUT_TEST_RUN: '0' } as NodeJS.ProcessEnv)).toEqual({})
  })
})
