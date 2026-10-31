/**
 * The prompts of the follow rule (sessions/org-follow.ts, task-watch.ts; 2026-10-31): Main and every
 * lead read how Walnut hands them their tasks' turn ends and completions, how to watch one, and (a
 * lead) where to keep its tracking; a top-level task reads whom it reports to; a worker reads none.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-org-follow-prompt'))

import { WALNUT_HOME } from '../../../src/constants.js'
import { buildSessionContext, ORG_FOLLOW_LINE } from '../../../src/core/sessions/session-context.js'
import { addTask, updateTaskRaw } from '../../../src/core/task-manager.js'
import type { Task } from '../../../src/core/types.js'

let vp = ''
let top = ''
let worker = ''
const promptOf = async (id: string, over: Partial<Task> = {}) => {
  const { getTask } = await import('../../../src/core/task-manager.js')
  return (await buildSessionContext(id, '/x', 'h', { task: { ...(await getTask(id)), ...over } })).systemPrompt
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  vp = (await addTask({ title: 'Garden VP', project: 'Garden' })).task.id
  await updateTaskRaw(vp, { org_role: 'lead' }, { source: 'test' })
  top = (await addTask({ title: 'Tune the cache', project: 'Garden' })).task.id
  worker = (await addTask({ title: 'Write the lexer', project: 'Garden' })).task.id
  await updateTaskRaw(worker, { parent_task_id: top }, { source: 'test' })
})
afterAll(async () => { await fs.rm(WALNUT_HOME, { recursive: true, force: true }) })

describe('the follow rule', () => {
  it('rides a lead and Main, with the watch and the lead tracking in MEMORY.md', async () => {
    const lead = await promptOf(vp)
    expect(lead).toContain(ORG_FOLLOW_LINE)
    expect(lead).toMatch(/task_watch \{"id":"…","every":"3h"\}/)
    expect(lead).toMatch(/Keep your own tracking in your MEMORY\.md/)
    const main = await promptOf(vp, { org_role: 'main' })
    expect(main).toContain(ORG_FOLLOW_LINE)
    expect(main).not.toMatch(/Keep your own tracking in your MEMORY\.md/)
  })

  it('a top-level task names the VP it reports to; a worker reads no such line', async () => {
    const own = await promptOf(top)
    expect(own).toContain(`Your task reports to "Garden VP" (id ${vp}), the VP that leads its project.`)
    expect(own).toMatch(/Tell it yourself \(task_send\) only what it must act on/)
    expect(own).not.toContain(ORG_FOLLOW_LINE)
    expect(await promptOf(worker)).not.toContain('Your task reports to')
  })
})
