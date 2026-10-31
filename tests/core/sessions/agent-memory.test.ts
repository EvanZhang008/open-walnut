/**
 * An agent's own MEMORY.md (src/core/sessions/agent-memory.ts): the size rules, the turn-end ask
 * through the real runTriage (only the CLI faked), the route's write guard, and that no task
 * list carries it.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-agent-memory'))

// The calling session's task, as the session registry would answer for a live session.
const ownCallers = new Map<string, string>()
vi.mock('../../../src/core/sessions/session-send-core.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../src/core/sessions/session-send-core.js')>()
  return {
    ...orig,
    resolveCaller: async (sid: string | undefined) => {
      const taskId = sid ? ownCallers.get(sid) : undefined
      return taskId ? { kind: 'session', record: { taskId } } : orig.resolveCaller(sid)
    },
  }
})

import express from 'express'
import request from 'supertest'
import { WALNUT_HOME } from '../../../src/constants.js'
import { sessionRunner } from '../../../src/providers/claude-code-session.js'
import { addTask, getTask, queryTasksSlimPage, updateTaskRaw } from '../../../src/core/task-manager.js'
import { runTriage, __resetTriageRateLimiter } from '../../../src/core/session-hooks/builtins.js'
import type { OnTurnCompletePayload } from '../../../src/core/session-hooks/types.js'
import type { Task } from '../../../src/core/types.js'
import {
  AGENT_MEMORY_MAX_CHARS, AGENT_MEMORY_SOFT_CHARS, AgentMemoryTooLongError, agentMemoryAfterCompaction,
  agentMemoryPrompt, agentMemoryWriterName, agentMemoryWriterNote, applyAgentMemoryAnswer, keepsAgentMemory, nextAgentMemory,
  readAgentMemoryField, splitAgentMemory,
} from '../../../src/core/sessions/agent-memory.js'
import { taskView } from '../../../src/ops/task-execution.js'
import { agentMemoryV1Router } from '../../../src/web/routes/agent-memory-v1.js'
import { errorHandler } from '../../../src/web/middleware/error-handler.js'

const NOW = '2026-10-27T09:00:00.000Z'

describe('the MEMORY.md rules', () => {
  it('append adds one dated entry; replace sets the whole file', () => {
    expect(nextAgentMemory('', 'Call the supplier Friday', 'append', NOW)).toBe('- 2026-10-27: Call the supplier Friday')
    expect(nextAgentMemory('- 2026-10-26: one\n', '- two', 'append', NOW)).toBe('- 2026-10-26: one\n- 2026-10-27: two')
    expect(nextAgentMemory('old', '  # Mine\n- a  ', 'replace', NOW)).toBe('# Mine\n- a')
  })

  it('refuses a file past the limit whole, never cuts it', () => {
    const big = 'x'.repeat(AGENT_MEMORY_MAX_CHARS - 5)
    expect(() => nextAgentMemory(big, 'one more entry', 'append', NOW)).toThrow(AgentMemoryTooLongError)
    expect(() => nextAgentMemory('', 'y'.repeat(AGENT_MEMORY_MAX_CHARS + 1), 'replace', NOW)).toThrow(/Nothing was written/)
    expect(nextAgentMemory('', 'y'.repeat(AGENT_MEMORY_MAX_CHARS), 'replace', NOW)).toHaveLength(AGENT_MEMORY_MAX_CHARS)
  })

  it('writes only for an explicit append: or replace:, never for a stray answer', () => {
    expect(readAgentMemoryField(null)).toBeNull()
    for (const keep of ['', 'unchanged', 'Unchanged.', '**unchanged**', '`unchanged`', 'unchanged (nothing new)', 'No change.', 'none',
      '# Mine\n- a', 'append', 'replace:', '<the whole file, rewritten>']) {
      expect(readAgentMemoryField(keep), keep).toBeNull()
    }
    expect(readAgentMemoryField('append: Ask about the fence on Monday')).toEqual({ mode: 'append', content: 'Ask about the fence on Monday' })
    expect(readAgentMemoryField('**append:** Ask Monday')).toEqual({ mode: 'append', content: 'Ask Monday' })
    expect(readAgentMemoryField('append - Ask Monday')).toBeNull()
    expect(readAgentMemoryField('append-only items: x')).toBeNull()
    expect(readAgentMemoryField('replace:\n# Mine\n- a\n- b')).toEqual({ mode: 'replace', content: '# Mine\n- a\n- b' })
    // A file that starts with a task reference keeps it.
    const ref = '<task-ref id="t1" label="Fence"/> waits on paint'
    expect(readAgentMemoryField(`replace:\n${ref}`)).toEqual({ mode: 'replace', content: ref })
  })

  it('splits the report at its last AGENT_MEMORY label, so label-like lines stay in the file', () => {
    const report = 'STATUS: succeeded\nFOR_USER_NEXT: carry on.\n**AGENT_MEMORY:** replace:\n# Garden\nSTATUS: review pending\nGOAL\nLINKS: https://example.com/x'
    const { head, field } = splitAgentMemory(report)
    expect(head).toBe('STATUS: succeeded\nFOR_USER_NEXT: carry on.')
    expect(readAgentMemoryField(field)).toEqual({ mode: 'replace', content: '# Garden\nSTATUS: review pending\nGOAL\nLINKS: https://example.com/x' })
    expect(splitAgentMemory('STATUS: ok')).toEqual({ head: 'STATUS: ok', field: null })
    // The label alone on its line, with no colon, still cuts the report.
    const bare = splitAgentMemory('STATUS: ok\nAGENT_MEMORY\nreplace:\n- a\nLINKS: http://y')
    expect(bare.head).toBe('STATUS: ok')
    expect(readAgentMemoryField(bare.field)).toEqual({ mode: 'replace', content: '- a\nLINKS: http://y' })
  })

  it('skips a rewrite of a file that changed since the ask, keeps an entry, and records a refusal', () => {
    const cur = { text: '- a', at: '2026-10-27T08:00:00.000Z' }
    expect(applyAgentMemoryAnswer(cur, { mode: 'replace', content: 'x' }, '2026-10-26T08:00:00.000Z', NOW)).toEqual({ memory: null, outcome: 'stale' })
    expect(applyAgentMemoryAnswer(cur, { mode: 'replace', content: 'x' }, cur.at, NOW)).toEqual({ memory: { text: 'x', at: NOW }, outcome: 'written' })
    expect(applyAgentMemoryAnswer(cur, { mode: 'append', content: 'b' }, undefined, NOW).memory?.text).toBe('- a\n- 2026-10-27: b')
    expect(applyAgentMemoryAnswer(undefined, { mode: 'replace', content: 'first' }, undefined, NOW).memory?.text).toBe('first')
    const refused = applyAgentMemoryAnswer(cur, { mode: 'replace', content: 'r'.repeat(AGENT_MEMORY_MAX_CHARS + 1) }, cur.at, NOW)
    expect(refused).toEqual({ memory: { ...cur, refused: { at: NOW, chars: AGENT_MEMORY_MAX_CHARS + 1 } }, outcome: 'refused' })
    // A later good write drops the refusal.
    expect(applyAgentMemoryAnswer(refused.memory!, { mode: 'append', content: 'c' }, cur.at, NOW).memory).not.toHaveProperty('refused')
    // The answer is the task's own write: an entry keeps the record of another's write (its time
    // too), a whole rewrite clears it, a refused one keeps it.
    const stamped = { ...cur, by: 'task:w1' as const, by_name: 'the task "W"', by_at: cur.at }
    expect(applyAgentMemoryAnswer(stamped, { mode: 'append', content: 'd' }, undefined, NOW).memory)
      .toMatchObject({ at: NOW, by: 'task:w1', by_name: 'the task "W"', by_at: cur.at })
    const rewritten = applyAgentMemoryAnswer(stamped, { mode: 'replace', content: 'all mine' }, cur.at, NOW).memory!
    expect(rewritten).toEqual({ text: 'all mine', at: NOW })
    expect(applyAgentMemoryAnswer(stamped, { mode: 'replace', content: 'r'.repeat(AGENT_MEMORY_MAX_CHARS + 1) }, cur.at, NOW).memory)
      .toMatchObject({ by: 'task:w1', by_name: 'the task "W"', by_at: cur.at, refused: { at: NOW } })
  })

  it('Main, a lead and a leader keep one; a plain worker does not', () => {
    expect(keepsAgentMemory({ org_role: 'main' } as Task, false)).toBe(true)
    expect(keepsAgentMemory({ org_role: 'lead' } as Task, false)).toBe(true)
    expect(keepsAgentMemory({} as Task, true)).toBe(true)
    expect(keepsAgentMemory({} as Task, false)).toBe(false)
  })

  it('the ask shows the file, names it apart from the global MEMORY.md, and asks to compress past the soft size', () => {
    const small = agentMemoryPrompt({ text: '- 2026-10-26: one', at: NOW }, 'Garden "lead"')
    expect(small).toContain("working memory of \"Garden 'lead'\"")
    expect(small).toContain("not Walnut's global MEMORY.md")
    expect(small).toContain(`<own_memory chars="17" limit="${AGENT_MEMORY_SOFT_CHARS}">\n- 2026-10-26: one\n</own_memory>`)
    expect(small).not.toContain('rewritten shorter')
    expect(small).toContain('"AGENT_MEMORY: replace:" followed by the whole file')
    expect(small).toMatch(/\nAGENT_MEMORY:$/)
    expect(agentMemoryPrompt(undefined, 'x')).toContain('It is empty.')
    const over = agentMemoryPrompt({ text: 'z'.repeat(AGENT_MEMORY_SOFT_CHARS + 1), at: NOW }, 'x')
    expect(over).toContain('answer with replace and the whole file rewritten shorter')
    const refused = agentMemoryPrompt({ text: '- a', at: NOW, refused: { at: NOW, chars: 20_500 } }, 'x')
    expect(refused).toContain('Your last answer (20500 characters) was NOT written')
    expect(over).toContain(`past ${AGENT_MEMORY_MAX_CHARS} characters is not written at all`)
  })

  it('is read back after a compaction, and nothing is said when it is empty', () => {
    expect(agentMemoryAfterCompaction({ title: 'Garden lead', agent_memory: { text: '- a', at: NOW } }))
      .toBe("Your own MEMORY.md (for \"Garden lead\", yours only, not Walnut's global MEMORY.md; agent_memory_write changes it):\n- a")
    expect(agentMemoryAfterCompaction({ title: 'x' })).toBe('')
    const long = agentMemoryAfterCompaction({ title: 'x', agent_memory: { text: 'k'.repeat(9_000), at: NOW } })
    expect(long).toContain('… (3000 more characters: agent_memory_read reads the whole file)')
    expect(long.length).toBeLessThan(6_300)
    expect(agentMemoryAfterCompaction({ title: 'x', agent_memory: { text: '  ', at: NOW } })).toBe('')
  })
})

const LEAD_SID = 'memory-lead-session'
const WORKER_SID = 'memory-worker-session'

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

const REPORT = (brief: string | null, memory: string) => [
  'EXEC_SUMMARY: The garden work goes on.', 'WORK_LOG: unchanged', 'RECAP: Checked the teams.',
  'PHASE_SIGNAL: conversational(user-asked-question)', 'STATUS: succeeded',
  'FOR_USER_STATE: waiting', 'FOR_USER_WAITING_ON: task: its teams', 'FOR_USER_NOW: Two teams work.', 'FOR_USER_NEXT: They carry on.',
  ...(brief === null ? [] : ['FOR_USER_BRIEF:', brief]),
  `AGENT_MEMORY: ${memory}`,
].join('\n')

let lead: Task
let leader: Task
let worker: Task
let main: Task

function createApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/v1', agentMemoryV1Router)
  app.use(errorHandler)
  return app
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  lead = (await addTask({ title: 'Garden lead', project: 'Garden' })).task
  await updateTaskRaw(lead.id, { org_role: 'lead', phase: 'IN_PROGRESS' } as never)
  lead = await getTask(lead.id)
  leader = (await addTask({ title: 'Fence team', project: 'Garden' })).task
  worker = (await addTask({ title: 'Fix the fence', project: 'Garden' })).task
  await updateTaskRaw(worker.id, { parent_task_id: leader.id } as never)
  main = (await addTask({ title: 'Main', project: 'Garden' })).task
  await updateTaskRaw(main.id, { org_role: 'main', phase: 'IN_PROGRESS' } as never)
})

afterAll(async () => {
  const map = (sessionRunner as unknown as { sessions: Map<string, unknown> }).sessions
  map.delete(LEAD_SID)
  map.delete(WORKER_SID)
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
})

beforeEach(() => __resetTriageRateLimiter())

describe('MEMORY.md in the turn-end self-report', () => {
  it('asks a lead after its Brief and stores the entry; the Brief stops where the memory starts', async () => {
    const fake = fakeSession(LEAD_SID, REPORT('**Needs you:** nothing.', 'append: The fence supplier answers by Friday.'))
    await runTriage(payload(LEAD_SID, lead))
    const prompt = fake.askSideQuestion.mock.calls[0]![0] as string
    expect(prompt.indexOf('FOR_USER_BRIEF:')).toBeGreaterThan(0)
    expect(prompt.indexOf('AGENT_MEMORY:')).toBeGreaterThan(prompt.indexOf('FOR_USER_BRIEF:'))
    expect(prompt).toContain('a deadline days away, a reminder or a thing for later goes into your own MEMORY.md')
    const stored = await getTask(lead.id)
    expect(stored.brief?.text).toBe('### Needs you\n- nothing.\n\n### Working\n- None\n\n### Waiting / snoozed\n- None')
    expect(stored.agent_memory?.text).toMatch(/^- \d{4}-\d{2}-\d{2}: The fence supplier answers by Friday\.$/)
  })

  it('shows the stored file next time and keeps it on "unchanged"', async () => {
    const before = (await getTask(lead.id)).agent_memory
    const fake = fakeSession(LEAD_SID, REPORT('unchanged', 'unchanged'))
    await runTriage(payload(LEAD_SID, await getTask(lead.id)))
    expect(fake.askSideQuestion.mock.calls[0]![0] as string).toContain('The fence supplier answers by Friday.\n</own_memory>')
    expect((await getTask(lead.id)).agent_memory).toEqual(before)
  })

  it('an answer past the limit writes nothing, and the next ask says it was not written', async () => {
    const before = (await getTask(lead.id)).agent_memory!
    fakeSession(LEAD_SID, REPORT('unchanged', `replace:\n${'q'.repeat(AGENT_MEMORY_MAX_CHARS + 10)}`))
    await runTriage(payload(LEAD_SID, await getTask(lead.id)))
    const after = (await getTask(lead.id)).agent_memory!
    expect(after.text).toBe(before.text)
    expect(after.refused?.chars).toBe(AGENT_MEMORY_MAX_CHARS + 10)
    __resetTriageRateLimiter()
    const fake = fakeSession(LEAD_SID, REPORT('unchanged', 'unchanged'))
    await runTriage(payload(LEAD_SID, await getTask(lead.id)))
    expect(fake.askSideQuestion.mock.calls[0]![0] as string).toContain(`Your last answer (${AGENT_MEMORY_MAX_CHARS + 10} characters) was NOT written`)
    // Said once: the "unchanged" answer lets it go.
    expect((await getTask(lead.id)).agent_memory).toEqual({ text: before.text, at: before.at })
    __resetTriageRateLimiter()
    const again = fakeSession(LEAD_SID, REPORT('unchanged', 'unchanged'))
    await runTriage(payload(LEAD_SID, await getTask(lead.id)))
    expect(again.askSideQuestion.mock.calls[0]![0] as string).not.toContain('was NOT written')
  })

  it('a rewrite with label-like lines is stored whole and feeds no other field', async () => {
    const file = '# Garden\nSTATUS: review pending\nLINKS: https://example.com/fence\n- ask about paint'
    fakeSession(LEAD_SID, REPORT('unchanged', `replace:\n${file}`))
    await runTriage(payload(LEAD_SID, await getTask(lead.id)))
    const after = await getTask(lead.id)
    expect(after.agent_memory?.text).toBe(file)
    expect(after.agent_memory).not.toHaveProperty('refused')
    expect(JSON.stringify(after.ext ?? {})).not.toContain('example.com/fence')
    expect(after.status_report?.next).toBe('They carry on.')
  })

  it('a stray "**unchanged**" keeps the file', async () => {
    const before = (await getTask(lead.id)).agent_memory
    fakeSession(LEAD_SID, REPORT('unchanged', '**unchanged** (nothing new)'))
    await runTriage(payload(LEAD_SID, await getTask(lead.id)))
    expect((await getTask(lead.id)).agent_memory).toEqual(before)
  })

  it('asks Main too', async () => {
    const fake = fakeSession(LEAD_SID, REPORT('**Needs you:** nothing.', 'append: Raise the budget next week.'))
    await runTriage(payload(LEAD_SID, await getTask(main.id)))
    expect(fake.askSideQuestion.mock.calls[0]![0] as string).toContain('AGENT_MEMORY:')
    expect((await getTask(main.id)).agent_memory?.text).toContain('Raise the budget next week.')
  })

  it('asks a leader with an open subtask, with no Brief', async () => {
    const fake = fakeSession(WORKER_SID, REPORT(null, 'append: Check the fence paint.'))
    await runTriage(payload(WORKER_SID, await getTask(leader.id)))
    const prompt = fake.askSideQuestion.mock.calls[0]![0] as string
    expect(prompt).not.toContain('FOR_USER_BRIEF')
    expect(prompt).toContain('AGENT_MEMORY:')
    expect((await getTask(leader.id)).agent_memory?.text).toContain('Check the fence paint.')
  })

  it('never asks a plain worker', async () => {
    const fake = fakeSession(WORKER_SID, REPORT(null, 'append: should not be stored'))
    await runTriage(payload(WORKER_SID, await getTask(worker.id)))
    expect(fake.askSideQuestion.mock.calls[0]![0] as string).not.toContain('AGENT_MEMORY')
    expect((await getTask(worker.id)).agent_memory).toBeUndefined()
  })
})

describe('the MEMORY.md route and the task lists', () => {
  it('reads it with its size and limits', async () => {
    const res = await request(createApp()).get(`/api/v1/tasks/${lead.id}/agent-memory`)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ task_id: lead.id, title: 'Garden lead', soft_limit: AGENT_MEMORY_SOFT_CHARS, limit: AGENT_MEMORY_MAX_CHARS })
    expect(res.body.chars).toBe(res.body.memory.text.length)
  })

  it('a person writes it; past the limit is 413 and nothing changes', async () => {
    const app = createApp()
    const put = await request(app).put(`/api/v1/tasks/${lead.id}/agent-memory`).send({ content: '# Garden\n- one', mode: 'replace' })
    expect(put.status).toBe(200)
    expect((await getTask(lead.id)).agent_memory?.text).toBe('# Garden\n- one')
    const big = await request(app).put(`/api/v1/tasks/${lead.id}/agent-memory`).send({ content: 'w'.repeat(AGENT_MEMORY_MAX_CHARS + 1) })
    expect(big.status).toBe(413)
    expect(big.body.error?.code ?? big.body.code).toBe('agent_memory_too_long')
    expect((await getTask(lead.id)).agent_memory?.text).toBe('# Garden\n- one')
  })

  it('its own session writes it; append is the default; parallel appends keep both', async () => {
    ownCallers.set('lead-own-sid', lead.id)
    const app = createApp()
    const [a, b] = await Promise.all([
      request(app).put(`/api/v1/tasks/${lead.id}/agent-memory`).set('x-walnut-caller-sid', 'lead-own-sid').send({ content: 'first' }),
      request(app).put(`/api/v1/tasks/${lead.id}/agent-memory`).set('x-walnut-caller-sid', 'lead-own-sid').send({ content: 'second' }),
    ])
    expect([a.status, b.status]).toEqual([200, 200])
    const text = (await getTask(lead.id)).agent_memory!.text
    expect(text.startsWith('# Garden\n- one\n')).toBe(true)
    expect(text).toMatch(/: first(\n|$)/)
    expect(text).toMatch(/: second(\n|$)/)
    await updateTaskRaw(lead.id, { agent_memory: { text: '# Garden\n- one', at: NOW } } as never)
  })

  // 2026-10-27, the user: "all human action can be done by agent also". A person writes any
  // task's MEMORY.md, so another task's session may too; the write is logged with who wrote it.
  it("another task's session writes it too, logged with its session and task", async () => {
    const { log } = await import('../../../src/logging/index.js')
    const info = vi.spyOn(log.task, 'info')
    ownCallers.set('worker-own-sid', worker.id)
    const res = await request(createApp()).put(`/api/v1/tasks/${lead.id}/agent-memory`)
      .set('x-walnut-caller-sid', 'worker-own-sid').send({ content: 'Fence paint arrives Friday' })
    expect(res.status).toBe(200)
    const written = (await getTask(lead.id)).agent_memory!
    expect(written.text).toMatch(/^# Garden\n- one\n- \d{4}-\d{2}-\d{2}: Fence paint arrives Friday$/)
    expect(info).toHaveBeenCalledWith("agent memory written by another task's session", {
      taskId: lead.id, mode: 'append', callerSid: 'worker-own-sid', callerTaskId: worker.id, chars: res.body.chars,
    })
    // The writer is on the file, so the owner reading it back (the ask, a compaction) is told whose it was.
    expect(written).toMatchObject({ by: `task:${worker.id}`, by_name: 'the task "Fix the fence"' })
    expect(res.body.memory).toMatchObject({ by: `task:${worker.id}`, by_name: 'the task "Fix the fence"' })
    const note = `Last written by the task "Fix the fence" at ${written.at}.`
    expect(agentMemoryPrompt(written, 'Garden lead')).toContain(`</own_memory>\n${note}`)
    expect(agentMemoryAfterCompaction({ title: 'Garden lead', agent_memory: written })).toContain(`agent_memory_write changes it):\n${note}\n# Garden`)
    // Its own session's write clears the writer and logs no such line.
    info.mockClear()
    ownCallers.set('lead-own-sid', lead.id)
    const own = await request(createApp()).put(`/api/v1/tasks/${lead.id}/agent-memory`)
      .set('x-walnut-caller-sid', 'lead-own-sid').send({ content: '# Garden\n- one', mode: 'replace' })
    expect(own.status).toBe(200)
    expect(info.mock.calls.filter(([msg]) => String(msg).includes('another task'))).toEqual([])
    const cleared = (await getTask(lead.id)).agent_memory!
    expect(cleared).not.toHaveProperty('by')
    expect(cleared).not.toHaveProperty('by_name')
    expect(agentMemoryPrompt(cleared, 'Garden lead')).not.toContain('Last written by')
    // A person's write is recorded as the user's, with no name.
    const person = await request(createApp()).put(`/api/v1/tasks/${lead.id}/agent-memory`).send({ content: '# Garden\n- one', mode: 'replace' })
    expect(person.status).toBe(200)
    const byPerson = (await getTask(lead.id)).agent_memory!
    expect(byPerson.by).toBe('human')
    expect(byPerson).not.toHaveProperty('by_name')
    expect(agentMemoryWriterNote(byPerson)).toBe(`Last written by the user at ${byPerson.at}.`)
    info.mockRestore()
    await updateTaskRaw(lead.id, { agent_memory: { text: '# Garden\n- one', at: NOW } } as never)
  })

  // 2026-10-27 review: the owner appends at every turn end, so an append must not erase the
  // record of a worker's write; only the owner rewriting the whole file does.
  it("the owner's turn-end entry keeps a worker's record; the owner replacing the file clears it", async () => {
    ownCallers.set('worker-own-sid', worker.id)
    ownCallers.set('lead-own-sid', lead.id)
    const put = await request(createApp()).put(`/api/v1/tasks/${lead.id}/agent-memory`)
      .set('x-walnut-caller-sid', 'worker-own-sid').send({ content: 'Paint is blue, not green' })
    expect(put.status).toBe(200)
    const byWorker = (await getTask(lead.id)).agent_memory!
    expect(byWorker).toMatchObject({ by: `task:${worker.id}`, by_name: 'the task "Fix the fence"', by_at: byWorker.at })
    const note = `Last written by the task "Fix the fence" at ${byWorker.at}.`

    // The lead's own turn end appends an entry: the worker's record and its time stay.
    __resetTriageRateLimiter()
    const fake = fakeSession(LEAD_SID, REPORT('unchanged', 'append: Order the blue paint.'))
    await runTriage(payload(LEAD_SID, await getTask(lead.id)))
    expect(fake.askSideQuestion.mock.calls[0]![0] as string).toContain(`</own_memory>\n${note}`)
    const afterAppend = (await getTask(lead.id)).agent_memory!
    expect(afterAppend.text).toMatch(/Paint is blue, not green\n- \d{4}-\d{2}-\d{2}: Order the blue paint\.$/)
    expect(afterAppend).toMatchObject({ by: `task:${worker.id}`, by_name: 'the task "Fix the fence"', by_at: byWorker.at })
    expect(agentMemoryAfterCompaction({ title: 'Garden lead', agent_memory: afterAppend })).toContain(note)
    // Its own PUT append keeps it too.
    await request(createApp()).put(`/api/v1/tasks/${lead.id}/agent-memory`).set('x-walnut-caller-sid', 'lead-own-sid').send({ content: 'one more' })
    expect(agentMemoryWriterNote((await getTask(lead.id)).agent_memory)).toBe(note)

    // The lead replaces the whole file: every line is its own now, and the note is gone.
    const replaced = await request(createApp()).put(`/api/v1/tasks/${lead.id}/agent-memory`)
      .set('x-walnut-caller-sid', 'lead-own-sid').send({ content: '# Garden\n- one', mode: 'replace' })
    expect(replaced.status).toBe(200)
    const mine = (await getTask(lead.id)).agent_memory!
    expect(mine).toEqual({ text: '# Garden\n- one', at: mine.at })
    expect(agentMemoryAfterCompaction({ title: 'Garden lead', agent_memory: mine })).not.toContain('Last written by')
    expect(agentMemoryPrompt(mine, 'Garden lead')).not.toContain('Last written by')
    await updateTaskRaw(lead.id, { agent_memory: { text: '# Garden\n- one', at: NOW } } as never)
  })

  it('names a writer as the user reads it, whitespace collapsed, at most 60 characters', () => {
    expect(agentMemoryWriterName({ title: 'Main', org_role: 'main' } as Task)).toBe('the CEO')
    expect(agentMemoryWriterName({ title: 'Growth lead', org_role: 'lead', org_name: '  Growth \n team ' } as Task)).toBe('the Growth team VP')
    expect(agentMemoryWriterName({ title: 'Fix   the\tfence' } as Task)).toBe('the task "Fix the fence"')
    const long = agentMemoryWriterName({ title: 'w'.repeat(200) } as Task)
    expect(long.length).toBe(60)
    expect(long).toMatch(/^the task "w+\u2026"$/)
    expect(agentMemoryWriterName(undefined)).toBe('an agent')
  })

  it('a completed task keeps its file (409), so the write never announces the completion again', async () => {
    const done = (await addTask({ title: 'Done lead', project: 'Garden' })).task
    await updateTaskRaw(done.id, { org_role: 'lead', phase: 'COMPLETE' } as never)
    const res = await request(createApp()).put(`/api/v1/tasks/${done.id}/agent-memory`).send({ content: 'late' })
    expect(res.status).toBe(409)
    expect((await getTask(done.id)).agent_memory).toBeUndefined()
  })

  it('task_get shows only its size', async () => {
    const view = taskView(await getTask(lead.id) as unknown as Record<string, unknown>)
    expect(view).not.toHaveProperty('agent_memory')
    expect(view.agent_memory_chars).toBe('# Garden\n- one'.length)
  })

  it('no task list carries it, slim or minimal', async () => {
    for (const minimal of [false, true]) {
      const page = await queryTasksSlimPage({}, { minimal })
      const row = page.tasks.find((t) => t.id === lead.id) as Record<string, unknown> | undefined
      expect(row).toBeDefined()
      expect(row).not.toHaveProperty('agent_memory')
    }
    expect((await getTask(lead.id)).agent_memory?.text).toBe('# Garden\n- one')
  })
})
