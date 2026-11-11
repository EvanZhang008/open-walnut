/**
 * An ask the task answered is owed to no one (src/core/sessions/user-asks-model.ts owedAsks).
 *
 * 2026-11-10, a VP's reflection: the "Owes the user an answer" line of a lead's team note
 * kept listing a user message long after the task answered it. One worker: he wrote at
 * 07:48Z "clean up the old photo thumbnails"; the task gave him a dry run and
 * "start with this plan?" at 08:59Z (status needs), yet its turn-end verdict kept naming the ask
 * owed (the cleanup was not done), so the note listed it at 6, 10, 12 and 13 hours and an idle wake
 * fired at 18:19Z. Another: the benchmark he asked for was delivered at 03:08Z (status
 * needs), still owed until 04:05Z, and woken about at 02:32Z while it waited on him.
 *
 * Replays both from their records: once the task's status hands the move back to him after his
 * message, the lead's note (staleOwedOf), the Stop hook and the wake (dueToWake) read nothing owed;
 * the 2026-11-03 class ("I'll check", status working) is still owed. Then the source: every reader
 * outside the model reads owed asks through owedAsks, so a new reader cannot skip the check.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-user-asks-answered'))

import { WALNUT_HOME } from '../../../src/constants.js'
import {
  addAsk, applyOwed, dueToWake, emptyUserAsks, handedToUser, owedAsks, owedQuestionBlock, staleOwed, type OwedStatus, type UserAsksFile,
} from '../../../src/core/sessions/user-asks-model.js'
import { staleOwedOf } from '../../../src/core/sessions/user-asks.js'

const H = 3600_000
const ms = (iso: string) => Date.parse(iso)

/** The cleanup case as its record held it: filed 07:48Z, judged owed at the 08:59Z turn end. */
function cleanupCase(): UserAsksFile {
  let f = emptyUserAsks('task-cleanup')
  f = addAsk(f, { id: 'ua-db12d9f2', at: '2026-11-10T07:48:08.858Z', text: 'clean up the old photo thumbnails', via: 'chat' }).file
  return applyOwed(f, ['ua-db12d9f2'], new Set(['ua-db12d9f2']), '2026-11-10T08:59:40.291Z').file
}

/** The benchmark case: filed 01:22Z, judged owed at 01:23Z and again at the 03:08Z turn end that delivered it. */
function benchmarkCase(): UserAsksFile {
  let f = emptyUserAsks('task-benchmark')
  f = addAsk(f, { id: 'ua-3298998e', at: '2026-11-10T01:22:09.802Z', text: 'run the benchmark on a big photo library and show me the numbers', via: 'chat' }).file
  f = applyOwed(f, ['ua-3298998e'], new Set(['ua-3298998e']), '2026-11-10T01:23:56.032Z').file
  return f
}

const needs = (at: string, ask?: string): OwedStatus => ({ state: 'needs', source: 'session', at, checkedAt: at, ...(ask ? { ask } : {}) })
const working = (at: string): OwedStatus => ({ state: 'working', at })

describe('an answered ask is owed to no one', () => {
  it('the cleanup case: a dry run and "start with this plan?" hands it back; no flag at 6, 10, 12 or 13 hours, no wake', () => {
    const f = cleanupCase()
    const filed = ms(f.asks[0].at)
    for (const status of [needs('2026-11-10T08:59:40.306Z', 'Start the cleanup with this plan?'), needs('2026-11-10T08:59:40.306Z')]) {
      for (const h of [6, 10, 12, 13]) expect(staleOwed(f, status, filed + h * H)).toEqual([])
      expect(dueToWake(f, status, ms('2026-11-10T18:19:04.249Z'))).toEqual([])
    }
    // Had it said only "I'll check" and kept working, it would still owe him (the 2026-11-03 class).
    const still = working('2026-11-10T08:59:40.306Z')
    expect(staleOwed(f, still, filed + 6 * H).map((a) => a.id)).toEqual(['ua-db12d9f2'])
    expect(dueToWake(f, still, ms('2026-11-10T18:19:04.249Z')).map((a) => a.id)).toEqual(['ua-db12d9f2'])
  })

  it('the benchmark case: the delivered result (status needs) hands it back; no wake at 02:32Z, no flag after 03:08Z', () => {
    let f = benchmarkCase()
    expect(dueToWake(f, needs('2026-11-10T01:23:56.032Z'), ms('2026-11-10T02:32:13.937Z'))).toEqual([])
    f = applyOwed(f, ['ua-3298998e'], new Set(['ua-3298998e']), '2026-11-10T03:08:50.551Z').file
    expect(staleOwed(f, needs('2026-11-10T03:08:50.560Z'), ms('2026-11-10T03:40:00Z'))).toEqual([])
  })

  it('a message he writes after the hand-back is owed again; a failed session hands nothing back', () => {
    let f = cleanupCase()
    f = addAsk(f, { id: 'ua-later001', at: '2026-11-10T10:00:00.000Z', text: 'and the video previews?', via: 'chat' }).file
    f = applyOwed(f, ['ua-db12d9f2', 'ua-later001'], new Set(['ua-db12d9f2', 'ua-later001']), '2026-11-10T10:01:00.000Z').file
    expect(owedAsks(f, needs('2026-11-10T08:59:40.306Z')).map((a) => a.id)).toEqual(['ua-later001'])
    // Its own question asked before he wrote again does not answer the new message.
    expect(owedAsks(f, needs('2026-11-10T08:59:40.306Z', 'Start?')).map((a) => a.id)).toEqual(['ua-later001'])
    // Walnut's live record of what waits on him (a prompt, a letter, a Board choice) is his move whenever he wrote.
    expect(owedAsks(f, { state: 'needs', source: 'choice', ask: 'Pick a design' })).toEqual([])
    // A failed, machine-stopped or limited session carries an ask too, and answered nothing.
    const late = '2026-11-10T11:00:00Z'
    expect(handedToUser({ state: 'needs', source: 'error', ask: 'The session failed: restart it?', at: late }, f.asks[1])).toBe(false)
    expect(handedToUser({ state: 'needs', source: 'session', ask: 'Start?', at: late, stoppedBy: 'machine' }, f.asks[1])).toBe(false)
    expect(handedToUser({ state: 'needs', source: 'session', ask: 'Start?', at: late, limit: { engine: 'claude', auto: true } }, f.asks[1])).toBe(false)
    expect(handedToUser({ state: 'needs', source: 'session', ask: 'Start?', at: late }, f.asks[1])).toBe(true)
    expect(handedToUser({ state: 'read', toRead: 'answer', at: '2026-11-10T11:00:00Z' }, f.asks[1])).toBe(true)
    expect(handedToUser({ state: 'read', toRead: 'turn', at: '2026-11-10T11:00:00Z' }, f.asks[1])).toBe(false)
  })

  it('the turn-end question counts a plan or a question back as an answer, and "on it" as owed', () => {
    const block = owedQuestionBlock(cleanupCase().asks, ms('2026-11-10T09:00:00Z'))
    expect(block).toContain('[ua-db12d9f2]')
    expect(block).toMatch(/"I will check" and "on it" are still owed/)
    expect(block).toMatch(/what he needs to decide \(a plan, a dry run, a question back to him\)/)
    expect(block).toMatch(/Work that still goes on after that answer belongs in your status/)
    expect(block).not.toMatch(/not done and reported back/)
  })
})

describe('the lead\'s note reads the same value', () => {
  beforeAll(async () => {
    await fsp.mkdir(path.join(WALNUT_HOME, 'user-asks'), { recursive: true })
    for (const f of [cleanupCase(), benchmarkCase()]) {
      await fsp.writeFile(path.join(WALNUT_HOME, 'user-asks', `${f.taskId}.json`), JSON.stringify(f))
    }
  })
  afterAll(async () => { await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {}) })

  it('staleOwedOf lists neither task once its status handed the move back, and lists one that only said "on it"', async () => {
    const base = { org_role: undefined, plugin_only: undefined, phase: 'NEED_ACTION' } as const
    const now = ms('2026-11-10T20:00:00Z')
    const answered = await staleOwedOf([
      { ...base, id: 'task-cleanup', user_status: needs('2026-11-10T08:59:40.306Z', 'Start?') as never },
      { ...base, id: 'task-benchmark', user_status: needs('2026-11-10T03:08:50.560Z') as never },
    ], now)
    expect([...answered.keys()]).toEqual([])
    const owed = await staleOwedOf([{ ...base, phase: 'IN_PROGRESS', id: 'task-cleanup', user_status: working('2026-11-10T08:59:40.306Z') as never }], now)
    expect([...owed.keys()]).toEqual(['task-cleanup'])
  })
})

describe('every reader of owed asks goes through owedAsks', () => {
  const SRC = path.resolve(__dirname, '../../../src')
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p, out)
      else if (p.endsWith('.ts') || p.endsWith('.tsx')) out.push(p)
    }
    return out
  }

  it('no file outside the model reads an ask\'s owedAt, and the three readers pass the task\'s status', () => {
    const model = path.join(SRC, 'core/sessions/user-asks-model.ts')
    const readers = walk(SRC).filter((f) => f !== model && /\.owedAt\b/.test(fs.readFileSync(f, 'utf8')))
    expect(readers.map((f) => path.relative(SRC, f))).toEqual([])
    const store = fs.readFileSync(path.join(SRC, 'core/sessions/user-asks.ts'), 'utf8')
    const calls = store.split('\n').filter((l) => /\b(?:staleOwed|dueToWake|owedAsks)\(/.test(l))
    expect(calls.length).toBeGreaterThanOrEqual(3)
    for (const l of calls) expect(l, `reads owed asks without the task's status: ${l.trim()}`).toMatch(/user_status/)
    // The lead's note takes its owed list from the store, not its own reading of the file.
    expect(fs.readFileSync(path.join(SRC, 'core/org/team-note.ts'), 'utf8')).toMatch(/staleOwedOf\(open, nowMs\)/)
  })
})
