/**
 * The host's attach rule for its own sessions (src/core/session-channel/host-judged-lines.ts) and
 * the replay floor of an attach (src/providers/attach-evidence.ts judgedReplayFloor).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { attachJudgeFirst, mayStillRun, setJudgeAttach, startOwnAttach, type OwnRowLike } from '../../../src/core/session-channel/host-judged-lines.js'
import { judgedReplayFloor, type StreamEvidence } from '../../../src/providers/attach-evidence.js'

const noAcp = (e: string | undefined) => e === 'acp-x'
const row = (sid: string, extra: Partial<OwnRowLike> = {}): OwnRowLike => ({ claudeSessionId: sid, pid: 42, type: 'interactive', process_status: 'idle', ...extra })

describe('attachJudgeFirst', () => {
  afterEach(() => setJudgeAttach(null))

  it('is a no-op when nothing is installed (a host that runs no sessions, the leader)', async () => {
    await expect(attachJudgeFirst('s1', 'test')).resolves.toBeUndefined()
  })

  it('asks the installed attach, and never throws when it fails', async () => {
    const asked: string[] = []
    setJudgeAttach(async (sid, p) => { asked.push(`${sid}:${p}`) })
    await attachJudgeFirst('s1', 'away-sends')
    await attachJudgeFirst('', 'away-sends')
    await attachJudgeFirst(undefined, 'away-sends')
    expect(asked).toEqual(['s1:away-sends'])
    setJudgeAttach(async () => { throw new Error('no runtime') })
    await expect(attachJudgeFirst('s2', 'write-port')).resolves.toBeUndefined()
  })
})

describe('startOwnAttach: the boot passes over the own rows', () => {
  it('attaches each row that may still run and is not held, and tries the rest again at the next pass', async () => {
    const held = new Set<string>(['held'])
    const alive = new Set<string>(['a'])
    const tried: string[] = []
    const rows = [row('a'), row('b'), row('held'), row('stopped', { process_status: 'stopped' }), row('nopid', { pid: null }),
      row('acp', { engine: 'acp-x' }), row('archived', { archived: true }), row('triage', { type: 'triage' })]
    const own = startOwnAttach({
      ownRows: async () => rows,
      holds: (sid) => held.has(sid),
      attach: async (sid) => { tried.push(sid); if (!alive.has(sid)) return false; held.add(sid); return true },
      isAcp: noAcp,
      passesMs: [0, 5],
    })
    await own.done
    // b is tried again at the second pass (its CLI was not adopted yet); a is held by then.
    expect(tried).toEqual(['a', 'b', 'b'])
  })

  it('a stop ends the passes at once', async () => {
    const tried: string[] = []
    const own = startOwnAttach({ ownRows: async () => [row('a')], holds: () => false, attach: async (sid) => { tried.push(sid); return false }, isAcp: noAcp, passesMs: [0, 60_000] })
    await new Promise((r) => setTimeout(r, 20))
    own.stop()
    await own.done
    expect(tried).toEqual(['a'])
  })

  it('mayStillRun: a live interactive native row only', () => {
    expect(mayStillRun(row('a'), noAcp)).toBe(true)
    expect(mayStillRun(row('a', { process_status: 'running' }), noAcp)).toBe(true)
    expect(mayStillRun(row('a', { process_status: 'stopped' }), noAcp)).toBe(false)
    expect(mayStillRun(row('a', { engine: 'acp-x' }), noAcp)).toBe(false)
  })
})

describe('judgedReplayFloor', () => {
  const ev = (fileSize: number, endOffset?: number): StreamEvidence => ({
    fileSize,
    fold: { lastResult: endOffset === undefined ? null : { isError: false, endOffset } } as never,
  })

  it('an own row with a result past its judged watermark replays from the watermark', () => {
    expect(judgedReplayFloor(true, 1000, ev(5000, 4800))).toBe(1000)
    expect(judgedReplayFloor(true, 0, ev(5000, 4800)), 'a watermark reset to a new file\'s start').toBe(0)
  })

  it('no replay: the last result is the judged one, no result, no watermark, a dead file, no evidence, or not an own row', () => {
    expect(judgedReplayFloor(true, 4800, ev(5000, 4800)), 'the result at the watermark was judged').toBeNull()
    expect(judgedReplayFloor(true, 1000, ev(5000)), 'no result in the tail: a turn still running comes live').toBeNull()
    expect(judgedReplayFloor(true, -1, ev(5000, 4800)), 'no watermark').toBeNull()
    expect(judgedReplayFloor(true, 6000, ev(5000, 4800)), 'beyond the file').toBeNull()
    expect(judgedReplayFloor(true, 1000, 'no-stream-file'), 'no evidence').toBeNull()
    expect(judgedReplayFloor(false, 1000, ev(5000, 4800)), 'a session the leader judges keeps the future-only attach').toBeNull()
  })
})
