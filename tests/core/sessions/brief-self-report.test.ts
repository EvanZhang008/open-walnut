/**
 * The Brief through the real turn-end self-report (runTriage in src/core/session-hooks/builtins.ts,
 * sessions/brief.ts), only the CLI faked: a lead is asked for FOR_USER_BRIEF with what moved in its
 * team since its last Brief, and its answer is stored on its task; a worker is never asked.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-brief-self-report'))

import { WALNUT_HOME } from '../../../src/constants.js'
import { sessionRunner } from '../../../src/providers/claude-code-session.js'
import { addTask, getTask, updateTaskRaw } from '../../../src/core/task-manager.js'
import { runTriage, __resetTriageRateLimiter } from '../../../src/core/session-hooks/builtins.js'
import type { OnTurnCompletePayload } from '../../../src/core/session-hooks/types.js'
import type { Task } from '../../../src/core/types.js'

const LEAD_SID = 'brief-lead-session'
const WORKER_SID = 'brief-worker-session'

function fakeSession(sid: string, answer: string) {
  const fake = { sessionId: sid, askSideQuestion: vi.fn(async () => answer), detach: () => {}, kill: () => {}, get active() { return false } }
  ;(sessionRunner as unknown as { sessions: Map<string, unknown> }).sessions.set(sid, fake)
  return fake
}

const payload = (sid: string, task: Task): OnTurnCompletePayload => ({
  sessionId: sid, taskId: task.id, task,
  session: { provider: 'claude-code', cwd: '/tmp/x' } as OnTurnCompletePayload['session'],
  result: 'done', totalCost: 0, duration: 1, turnIndex: 1,
} as OnTurnCompletePayload)

const REPORT = (brief: string) => [
  'EXEC_SUMMARY: The garden work goes on.', 'WORK_LOG: unchanged', 'RECAP: Checked the teams.',
  'PHASE_SIGNAL: conversational(user-asked-question)', 'STATUS: succeeded',
  'FOR_USER_STATE: waiting', 'FOR_USER_WAITING_ON: task: its teams', 'FOR_USER_NOW: Two teams work.', 'FOR_USER_NEXT: They carry on.',
  'FOR_USER_BRIEF:', brief,
].join('\n')

let lead: Task
let worker: Task

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  lead = (await addTask({ title: 'Garden lead', project: 'Garden' })).task
  await updateTaskRaw(lead.id, { org_role: 'lead', phase: 'IN_PROGRESS' } as never)
  lead = await getTask(lead.id)
  worker = (await addTask({ title: 'Fix the fence', project: 'Garden' })).task
})

afterAll(async () => {
  const map = (sessionRunner as unknown as { sessions: Map<string, unknown> }).sessions
  map.delete(LEAD_SID)
  map.delete(WORKER_SID)
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
})

beforeEach(() => __resetTriageRateLimiter())

describe('the Brief in the turn-end self-report', () => {
  it('asks a lead for it and stores the letter on its task', async () => {
    const letter = `**Needs you:** nothing.\n- <task-ref id="${worker.id}" label="Fix the fence"/>: half done.`
    const fake = fakeSession(LEAD_SID, REPORT(letter))
    await runTriage(payload(LEAD_SID, lead))
    const prompt = fake.askSideQuestion.mock.calls[0]![0] as string
    expect(prompt).toContain('FOR_USER_BRIEF:')
    expect(prompt).toContain('Write it every time')
    const stored = (await getTask(lead.id)).brief
    expect(stored?.text).toBe(letter)
    expect(Date.parse(stored!.at)).toBeGreaterThan(Date.now() - 60_000)
    // The Brief is the last field: FOR_USER_NEXT before it ends where the Brief starts.
    expect((await getTask(lead.id)).status_report?.next).toBe('They carry on.')
  })

  it('next time names what moved in the team since, and the rewrite replaces the letter', async () => {
    await new Promise((r) => setTimeout(r, 20))
    await updateTaskRaw(worker.id, { phase: 'NEED_ACTION' } as never)
    const fake = fakeSession(LEAD_SID, REPORT('**Needs you:** the fence supplier.'))
    lead = await getTask(lead.id)
    await runTriage(payload(LEAD_SID, lead))
    const prompt = fake.askSideQuestion.mock.calls[0]![0] as string
    expect(prompt).toContain('Rewrite it whole every time')
    expect(prompt).toContain('Since your last Brief, these moved in your team')
    expect(prompt).toContain(`<task-ref id="${worker.id}" label="Fix the fence"/>: now Needs you`)
    expect((await getTask(lead.id)).brief?.text).toBe('**Needs you:** the fence supplier.')
  })

  it('keeps the letter when the answer is "unchanged"', async () => {
    fakeSession(LEAD_SID, REPORT('unchanged'))
    await runTriage(payload(LEAD_SID, await getTask(lead.id)))
    expect((await getTask(lead.id)).brief?.text).toBe('**Needs you:** the fence supplier.')
  })

  it('writes nothing on a task completed while it was asked', async () => {
    const fake = fakeSession(LEAD_SID, REPORT('should not be stored'))
    fake.askSideQuestion.mockImplementation(async () => {
      await updateTaskRaw(lead.id, { phase: 'COMPLETE' } as never)
      return REPORT('should not be stored')
    })
    await runTriage(payload(LEAD_SID, await getTask(lead.id)))
    expect((await getTask(lead.id)).brief?.text).toBe('**Needs you:** the fence supplier.')
  })

  it('a Brief that breaks its rules is stored with its issues and asked for once more, right then', async () => {
    const bad = '**Needs you:**\n- The docs sync can be pushed.'
    const good = `**Needs you:**\n- <task-ref id="${worker.id}" label="Fix the fence"/>: approve the push of the fence notes to the shared repo.`
    const fake = fakeSession(LEAD_SID, REPORT(bad))
    fake.askSideQuestion.mockImplementationOnce(async () => REPORT(bad)).mockImplementationOnce(async () => `FOR_USER_BRIEF:\n${good}`)
    await updateTaskRaw(lead.id, { phase: 'IN_PROGRESS' } as never, { reopenTerminal: true })
    await runTriage(payload(LEAD_SID, await getTask(lead.id)))
    // The re-ask runs after the hook, without holding it.
    await vi.waitFor(async () => expect((await getTask(lead.id)).brief?.text).toBe(good))
    expect(fake.askSideQuestion).toHaveBeenCalledTimes(2)
    const fix = fake.askSideQuestion.mock.calls[1]![0] as string
    expect(fix).toContain('- names no task (start it with the <task-ref/> of the task it is about): - The docs sync can be pushed.')
    expect(fix).toContain(`<brief>\n${bad}\n</brief>`)
    expect((await getTask(lead.id)).brief).not.toHaveProperty('issues')
  })

  it('keeps the issues when the rewrite is no better, and the next ask lists them', async () => {
    __resetTriageRateLimiter()
    const bad = '- Still waiting on your pick.'
    const fake = fakeSession(LEAD_SID, REPORT(bad))
    await runTriage(payload(LEAD_SID, await getTask(lead.id)))
    await vi.waitFor(() => expect(fake.askSideQuestion).toHaveBeenCalledTimes(2))
    await new Promise((r) => setTimeout(r, 50))
    expect((await getTask(lead.id)).brief).toMatchObject({ text: bad, issues: [{ kind: 'no_task', line: bad }] })
    // The same broken line again is not re-asked: the next ask lists it.
    __resetTriageRateLimiter()
    const same = fakeSession(LEAD_SID, REPORT(bad))
    await runTriage(payload(LEAD_SID, await getTask(lead.id)))
    await new Promise((r) => setTimeout(r, 50))
    expect(same.askSideQuestion).toHaveBeenCalledTimes(1)
    __resetTriageRateLimiter()
    const next = fakeSession(LEAD_SID, REPORT(`- <task-ref id="${worker.id}" label="Fix the fence"/>: half done.`))
    await runTriage(payload(LEAD_SID, await getTask(lead.id)))
    expect(next.askSideQuestion.mock.calls[0]![0] as string).toContain('Walnut found these lines of your last Brief breaking the rules')
    expect(next.askSideQuestion).toHaveBeenCalledTimes(1)
    expect((await getTask(lead.id)).brief).not.toHaveProperty('issues')
  })

  it('never asks a worker, and stores nothing on it', async () => {
    const fake = fakeSession(WORKER_SID, REPORT('should not be stored'))
    await runTriage(payload(WORKER_SID, await getTask(worker.id)))
    expect(fake.askSideQuestion.mock.calls[0]![0] as string).not.toContain('FOR_USER_BRIEF')
    expect((await getTask(worker.id)).brief).toBeUndefined()
  })
})
