/**
 * A hand-back never carries an empty sentence (src/core/sessions/last-words.ts; 2026-11-01, Main's
 * reflection: a task handed back with no report read "Its turn ended and handed the task back to
 * you", and what it said was found only by opening it). Walnut reads where its last turn stopped and
 * the status carries those words; a hand-back after them makes them stale until read again. Since
 * 2026-11-02 that status asks nothing (ToRead `turn`): only a real ask reaches Needs you.
 *
 * Guard for the class: the bare turn sentence is the derive's words in one place only, behind the
 * last words, and no other file writes it.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-last-words'))

import { WALNUT_HOME } from '../../src/constants.js'
import { TURN_TO_READ, deriveUserStatus } from '../../src/core/user-status.js'
import { LAST_WORDS_MAX, __resetLastWords, currentLastWords, lastWordsText, runLastWordsPass } from '../../src/core/sessions/last-words.js'
import { HANDBACK_SETTLE_MS, syncUserStatuses } from '../../src/core/user-status-sync.js'
import { addTask, getTask, updateTaskRaw } from '../../src/core/task-manager.js'
import { createSessionRecord, updateSessionRecord } from '../../src/core/session-tracker.js'

describe('the words a turn ended with', () => {
  it('plain text, its end kept, and its last step when it said nothing', () => {
    expect(lastWordsText({ text: '**Done.** Please pick one of the `two dates` for the garden party.' })).toBe('Done. Please pick one of the two dates for the garden party.')
    expect(lastWordsText({ text: '<div style="x">Draft saved.</div>\n\n<walnut-turn status="agent-ack"/>' })).toBe('Draft saved.')
    const long = `${'The report is long. '.repeat(30)}Plant the roses on Friday or Sunday?`
    const cut = lastWordsText({ text: long })
    expect(cut.length).toBeLessThanOrEqual(LAST_WORDS_MAX + 1)
    expect(cut.startsWith('…')).toBe(true)
    expect(cut.endsWith('Plant the roses on Friday or Sunday?')).toBe(true)
    expect(lastWordsText({ text: '', actions: ['Bash: git push', 'Bash: open the report'] })).toBe('Its last step: Bash: open the report')
    expect(lastWordsText(undefined)).toBe('')
  })

  it('belong to the hand-back they were read after', () => {
    const lw = { text: 'Confirm it?', at: '2026-11-01T04:00:00Z', session_id: 's' }
    expect(currentLastWords({ phase_changed_at: '2026-11-01T03:59:30Z', last_words: lw })).toBe('Confirm it?')
    expect(currentLastWords({ phase_changed_at: '2026-11-01T05:00:00Z', last_words: lw })).toBeNull()
  })

  it('a hand-back with no report shows those words, and asks nothing', () => {
    const base = { phase: 'NEED_ACTION', hasSession: true, processStatus: 'stopped', phaseChangedAt: new Date(Date.now() - 60_000).toISOString() }
    expect(deriveUserStatus(base)).toMatchObject({ state: 'read', toRead: 'turn', waitingOn: TURN_TO_READ })
    expect(deriveUserStatus({ ...base, lastWords: 'Friday or Sunday?' })).toMatchObject({ state: 'read', toRead: 'turn', waitingOn: `${TURN_TO_READ}; its last words: "Friday or Sunday?"` })
  })
})

describe('on a real task', () => {
  const SID = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'
  let id = ''
  beforeAll(async () => {
    __resetLastWords()
    await fs.rm(WALNUT_HOME, { recursive: true, force: true })
    await fs.mkdir(WALNUT_HOME, { recursive: true })
    id = (await addTask({ title: 'Garden planner', project: 'Garden' })).task.id
    await createSessionRecord(SID, id, 'Garden', WALNUT_HOME)
    // A Personal AI chat lane, stopped: what the 2026-11-01 report showed (it reports no status itself).
    await updateSessionRecord(SID, { process_status: 'stopped', lane: 'chat:general:conv-1' } as never)
    await updateTaskRaw(id, { session_id: SID, phase: 'NEED_ACTION', phase_changed_at: new Date(Date.now() - 5 * 60_000).toISOString() } as never, { source: 'test' })
  })
  afterAll(async () => { await fs.rm(WALNUT_HOME, { recursive: true, force: true }) })

  it('a stopped session\'s hand-back reads its last message, and a later hand-back reads again', async () => {
    await syncUserStatuses(new Set([id]))
    expect((await getTask(id)).user_status?.waitingOn).toBe(TURN_TO_READ)
    const read = vi.fn(async () => ({ text: 'The seed order has two options: pick one?' }))
    expect(await runLastWordsPass(Date.now(), read)).toEqual([id])
    expect(read).toHaveBeenCalledWith(SID)
    await syncUserStatuses(new Set([id]))
    expect((await getTask(id)).user_status).toMatchObject({ state: 'read', toRead: 'turn', waitingOn: `${TURN_TO_READ}; its last words: "The seed order has two options: pick one?"` })
    // Read once: not again while the words stand.
    expect(await runLastWordsPass(Date.now() + 10 * 60_000, read)).toEqual([])
    // A new hand-back: the old words describe an older turn; the next pass reads the new ones.
    const lw = (await getTask(id)).last_words!
    await updateTaskRaw(id, { last_words: { ...lw, at: new Date(Date.now() - 10 * 60_000).toISOString() } }, { source: 'test' })
    await updateTaskRaw(id, { phase: 'IN_PROGRESS' }, { source: 'test' })
    await updateTaskRaw(id, { phase: 'NEED_ACTION' }, { source: 'test' })
    // Past the hand-back hold (user-status-sync.ts): the bare turn is stored only once it settled.
    await syncUserStatuses(new Set([id]), Date.now() + HANDBACK_SETTLE_MS + 1_000)
    expect((await getTask(id)).user_status?.waitingOn).toBe(TURN_TO_READ)
    read.mockResolvedValueOnce({ text: 'Moved the watering to 6 pm. Keep it?' })
    expect(await runLastWordsPass(Date.now() + 31 * 60_000, read)).toEqual([id])
    await syncUserStatuses(new Set([id]))
    expect((await getTask(id)).user_status?.waitingOn).toContain('Moved the watering to 6 pm. Keep it?')
  })
})

describe('guard: the bare turn sentence', () => {
  it('is the derive\'s words in one place, behind the last words, and no other file writes it', async () => {
    const root = path.resolve(__dirname, '../..')
    const src = await fs.readFile(path.join(root, 'src/core/user-status.ts'), 'utf8')
    const uses = src.split('\n').filter((l) => /toRead\('turn'/.test(l))
    expect(uses, 'A new hand-back status with the bare turn sentence: give it its last words (sessions/last-words.ts)').toHaveLength(1)
    expect(uses[0]).toMatch(/input\.lastWords \?/)
    expect(src.split('\n').filter((l) => /ask:.*HANDED_BACK_ASK/.test(l)), 'The old hand-back sentence is read, never written').toHaveLength(0)
    const walk = async (dir: string, out: string[] = []): Promise<string[]> => {
      for (const e of await fs.readdir(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) await walk(p, out)
        else if (/\.tsx?$/.test(e.name)) out.push(p)
      }
      return out
    }
    const writers: string[] = []
    for (const f of await walk(path.join(root, 'src'))) {
      if (f.endsWith('user-status.ts')) continue
      if (/ask:\s*HANDED_BACK_ASK|waitingOn:\s*TURN_TO_READ/.test(await fs.readFile(f, 'utf8'))) writers.push(path.relative(root, f))
    }
    expect(writers).toEqual([])
  })
})
