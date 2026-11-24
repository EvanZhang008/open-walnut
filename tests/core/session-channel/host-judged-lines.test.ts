/**
 * The host's attach rule for its own sessions (src/core/session-channel/host-judged-lines.ts), the
 * fact log's told line (fact-log.ts toldLine) and the replay floor of an attach
 * (src/providers/attach-evidence.ts judgedReplayFloor).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { attachJudgeFirst, installOwnAttach, mayStillRun, setJudgeAttach, startOwnAttach, toldLineOf, type OwnRowLike, type LiveCli } from '../../../src/core/session-channel/host-judged-lines.js'
import { FactLog, foldTold } from '../../../src/core/session-channel/fact-log.js'
import { judgedReplayFloor, type StreamEvidence } from '../../../src/providers/attach-evidence.js'

const judge = vi.hoisted(() => ({ here: new Set<string>(), standsDown: false }))
vi.mock('../../../src/core/sessions/judge-of.js', () => ({
  judgedHere: (sid: string) => !judge.standsDown && judge.here.has(sid),
  hostStandsDown: () => judge.standsDown,
}))

const isAcp = (e: string | undefined) => e === 'acp-x'
const row = (sid: string, extra: Partial<OwnRowLike> = {}): OwnRowLike => ({ claudeSessionId: sid, type: 'interactive', ...extra })

afterEach(() => { setJudgeAttach(null); judge.here.clear(); judge.standsDown = false })

describe('attachJudgeFirst', () => {
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

describe('installOwnAttach: the attach before a write', () => {
  function wire(o: { reads?: () => boolean; engines?: Record<string, string>; live?: Record<string, LiveCli> } = {}) {
    const attached: Array<{ sid: string; pid?: number }> = []
    const held = new Set<string>()
    const stop = installOwnAttach({
      runner: { attachOwnLive: async (sid, pid) => { attached.push({ sid, ...(pid !== undefined ? { pid } : {}) }); held.add(sid); return {} } },
      holds: (sid) => held.has(sid),
      ownRows: async () => [],
      engineOf: async (sid) => o.engines?.[sid],
      liveCli: async (sid) => o.live?.[sid] ?? null,
      toldLine: (sid) => (sid === 'told' ? { v: 99 } : undefined),
      readsReady: o.reads ?? (() => true),
      // The boot passes stay out of these cases.
      delayMs: 3_600_000,
    })
    return { attached, stop }
  }

  it('attaches an own session with the runtime\'s pid, once; the told lines are installed', async () => {
    judge.here.add('own')
    const w = wire({ live: { own: { pid: 4242 } } })
    const stop = await w.stop
    expect(toldLineOf('told')).toEqual({ v: 99 })
    await attachJudgeFirst('own', 'away-sends')
    await attachJudgeFirst('own', 'away-sends')
    expect(w.attached).toEqual([{ sid: 'own', pid: 4242 }])
    stop()
    expect(toldLineOf('told')).toBeUndefined()
  })

  it('skips a copied row, an ACP engine\'s session, a host standing down, and a CLI the runtime does not hold', async () => {
    judge.here.add('acp'); judge.here.add('dead'); judge.here.add('own')
    const w = wire({ engines: { acp: 'gemini' }, live: { acp: { pid: 1 }, own: { pid: 2 } } })
    const stop = await w.stop
    await attachJudgeFirst('copied', 'away-sends')
    await attachJudgeFirst('acp', 'away-sends')
    await attachJudgeFirst('dead', 'away-sends')
    judge.standsDown = true
    await attachJudgeFirst('own', 'away-sends')
    expect(w.attached).toEqual([])
    stop()
  })

  it('before this host reads its own streams it attaches nothing (the boot passes take it, reading on from the told line)', async () => {
    judge.here.add('own')
    let reads = false
    const w = wire({ reads: () => reads, live: { own: { pid: 2 } } })
    const stop = await w.stop
    await attachJudgeFirst('own', 'away-sends')
    expect(w.attached).toEqual([])
    reads = true
    await attachJudgeFirst('own', 'away-sends')
    expect(w.attached).toEqual([{ sid: 'own', pid: 2 }])
    stop()
  })
})

describe('startOwnAttach: the boot passes over the own rows', () => {
  it('attaches each own row whose CLI the runtime holds, whatever the row says, and asks the rest again at the next pass', async () => {
    const held = new Set<string>(['held'])
    // `resumed`: the daemon resumed it itself while the service was down; its row still says stopped, with no pid.
    const live: Record<string, LiveCli> = { a: { pid: 11 }, resumed: { pid: 12 } }
    const asked: string[] = []
    const attached: Array<[string, number | undefined]> = []
    const rows = [row('a'), row('b'), row('held'), row('resumed'), row('acp', { engine: 'acp-x' }), row('archived', { archived: true }), row('triage', { type: 'triage' })]
    const own = startOwnAttach({
      ownRows: async () => rows,
      holds: (sid) => held.has(sid),
      liveCli: async (sid) => { asked.push(sid); return live[sid] ?? null },
      attach: async (sid, pid) => { attached.push([sid, pid]); held.add(sid); return true },
      isAcp, passesMs: [0, 5],
    })
    await own.done
    expect(attached).toEqual([['a', 11], ['resumed', 12]])
    // b (no CLI yet) is asked again at the second pass; a and resumed are held by then.
    expect(asked).toEqual(['a', 'b', 'resumed', 'b'])
  })

  it('asks the runtime one list per pass, and only the rows it lists alive one by one', async () => {
    const asked: string[] = []
    const attached: string[] = []
    let lists = 0
    const own = startOwnAttach({
      ownRows: async () => [row('old-1'), row('old-2'), row('live'), row('old-3')],
      holds: () => false,
      liveSids: async () => { lists++; return new Set(['live', 'not-own']) },
      liveCli: async (sid) => { asked.push(sid); return { pid: 9 } },
      attach: async (sid) => { attached.push(sid); return true },
      isAcp, passesMs: [0],
    })
    await own.done
    expect({ lists, asked, attached }).toEqual({ lists: 1, asked: ['live'], attached: ['live'] })
    // No list answer (an older runtime, a slow link): every row is asked, as before.
    const asked2: string[] = []
    await startOwnAttach({ ownRows: async () => [row('a'), row('b')], holds: () => false, liveSids: async () => null, liveCli: async (sid) => { asked2.push(sid); return null }, attach: async () => true, isAcp, passesMs: [0] }).done
    expect(asked2).toEqual(['a', 'b'])
  })

  it('a host standing down attaches nothing; a stop ends the passes at once', async () => {
    const attached: string[] = []
    const down = startOwnAttach({ ownRows: async () => [row('a')], holds: () => false, liveCli: async () => ({ pid: 1 }), attach: async (sid) => { attached.push(sid); return true }, isAcp, standsDown: () => true, passesMs: [0] })
    await down.done
    expect(attached).toEqual([])
    const own = startOwnAttach({ ownRows: async () => [row('a')], holds: () => false, liveCli: async () => null, attach: async () => true, isAcp, passesMs: [0, 60_000] })
    await new Promise((r) => setTimeout(r, 20))
    own.stop()
    await own.done
  })

  it('mayStillRun: an interactive native row, whatever its status', () => {
    expect(mayStillRun(row('a'), isAcp)).toBe(true)
    expect(mayStillRun(row('a', { engine: 'acp-x' }), isAcp)).toBe(false)
    expect(mayStillRun(row('a', { archived: true }), isAcp)).toBe(false)
  })
})

describe('the fact log\'s told line', () => {
  it('is the furthest line a durable fact came from, kept across a reopen and a compaction, and a new file\'s first line resets it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'told-'))
    try {
      const log = await FactLog.open({ dir, walnutId: 'w1', durable: false, flushMs: 5 })
      log.append('s1', 'session:text-delta', { delta: 'a' }, { line: { epoch: 'e1', v: 100 } })
      log.append('s1', 'session:result', { result: 'r' }, { line: { epoch: 'e1', v: 250 } })
      log.append('s2', 'row', {})
      expect(log.toldLine('s1'), 'not durable yet: not told').toBeUndefined()
      await log.flush()
      expect(log.toldLine('s1')).toEqual({ epoch: 'e1', v: 250, end: true })
      expect(log.toldLine('s2')).toBeUndefined()
      await log.ack(log.head)
      await log.compact()
      await log.close()
      const again = await FactLog.open({ dir, walnutId: 'w1', durable: false, flushMs: 5 })
      expect(again.toldLine('s1'), 'after a compaction dropped its records').toEqual({ epoch: 'e1', v: 250, end: true })
      again.append('s1', 'session:text-delta', { delta: 'b' }, { line: { epoch: 'e2', v: 40 } })
      await again.flush()
      expect(again.toldLine('s1'), 'a new stream file').toEqual({ epoch: 'e2', v: 40 })
      await again.close()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('foldTold keeps the furthest line of one file, and whether a turn end came from it', () => {
    expect(foldTold({ v: 10 }, { v: 5 })).toEqual({ v: 10 })
    expect(foldTold({ v: 10 }, { v: 15 })).toEqual({ v: 15 })
    expect(foldTold(undefined, undefined)).toBeUndefined()
    expect(foldTold({ v: 10 }, { v: 15 }, 'session:result')).toEqual({ v: 15, end: true })
    expect(foldTold({ v: 15, end: true }, { v: 15 }, 'session:status-changed'), 'another fact of the result line').toEqual({ v: 15, end: true })
    expect(foldTold({ v: 15 }, { v: 15 }, 'session:result')).toEqual({ v: 15, end: true })
    expect(foldTold({ v: 15, end: true }, { v: 20 }, 'session:text-delta'), 'a later line').toEqual({ v: 20 })
  })
})

describe('judgedReplayFloor', () => {
  const ev = (fileSize: number, endOffset?: number, streamEpoch?: string): StreamEvidence => ({
    fileSize, ...(streamEpoch ? { streamEpoch } : {}),
    fold: { lastResult: endOffset === undefined ? null : { isError: false, endOffset } } as never,
  })

  it('reads on from the told line: a turn running at the restart is not said again, a result told is not said twice', () => {
    // Mid-turn: the leader heard up to 3000; the turn's end (4800) came while no runner read.
    expect(judgedReplayFloor(true, 1000, ev(5000, 4800, 'e1'), { epoch: 'e1', v: 3000 })).toEqual({ floor: 3000, from: 'told', atTurnEnd: false })
    // The result's fact went out, the record's watermark did not (a crash between): nothing is read again,
    // and the floor is the result's own line (its companion idle is owed).
    expect(judgedReplayFloor(true, 1000, ev(5000, 4800, 'e1'), { epoch: 'e1', v: 4800, end: true })).toEqual({ floor: 4800, from: 'told', atTurnEnd: true })
    // The record's watermark went out, the result's fact did not: it is read again and told.
    expect(judgedReplayFloor(true, 4800, ev(5000, 4800, 'e1'), { epoch: 'e1', v: 1000, end: true })).toEqual({ floor: 1000, from: 'told', atTurnEnd: true })
  })

  it('a fold with no verdict (no turn anchor) still places the told line by the file\'s size and epoch', () => {
    expect(judgedReplayFloor(true, -1, 'no-turn-anchor', { epoch: 'e1', v: 3000 }, { fileSize: 5000, streamEpoch: 'e1' })).toEqual({ floor: 3000, from: 'told', atTurnEnd: false })
    expect(judgedReplayFloor(true, -1, 'no-turn-anchor', { epoch: 'e1', v: 3000 }, { fileSize: 5000, streamEpoch: 'e2' })).toBeNull()
    expect(judgedReplayFloor(true, -1, 'no-turn-anchor', { v: 3000 })).toBeNull()
  })

  it('a told line with no epoch is not trusted in a file the stale-watermark heal found recreated', () => {
    expect(judgedReplayFloor(true, -1, ev(5000, 4800), { v: 3000 }, null, true)).toBeNull()
    expect(judgedReplayFloor(true, -1, ev(5000, 4800, 'e2'), { v: 3000 }, null, true)).toBeNull()
    expect(judgedReplayFloor(true, -1, ev(5000, 4800, 'e1'), { epoch: 'e1', v: 3000 }, null, true)).toEqual({ floor: 3000, from: 'told', atTurnEnd: false })
    expect(judgedReplayFloor(true, -1, ev(5000, 4800), { v: 3000 })).toEqual({ floor: 3000, from: 'told', atTurnEnd: false })
  })

  it('a told line of another file, or past this one, is not used', () => {
    expect(judgedReplayFloor(true, 1000, ev(5000, 4800, 'e2'), { epoch: 'e1', v: 3000 })).toEqual({ floor: 1000, from: 'judged', atTurnEnd: true })
    expect(judgedReplayFloor(true, -1, ev(5000, 4800), { v: 6000 })).toBeNull()
  })

  it('with no told line: the judged watermark, when a result was written past it', () => {
    expect(judgedReplayFloor(true, 1000, ev(5000, 4800))).toEqual({ floor: 1000, from: 'judged', atTurnEnd: true })
    expect(judgedReplayFloor(true, 4800, ev(5000, 4800)), 'the result at the watermark was judged').toBeNull()
    expect(judgedReplayFloor(true, 1000, ev(5000)), 'no result in the tail: a turn still running comes live').toBeNull()
    expect(judgedReplayFloor(true, -1, ev(5000, 4800)), 'no watermark').toBeNull()
    expect(judgedReplayFloor(true, 1000, 'no-stream-file'), 'no evidence').toBeNull()
    expect(judgedReplayFloor(false, 1000, ev(5000, 4800), { v: 3000 }), 'a session this server does not judge as its host').toBeNull()
  })
})
