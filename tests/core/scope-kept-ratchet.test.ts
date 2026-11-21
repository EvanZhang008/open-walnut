/**
 * A task never shrinks the scope the user set on its own (src/core/scope-kept.ts; 2026-11-21: a task
 * skipped phases 2 to 4 of a four-phase move by itself, three compactions kept the cut as a fact, and
 * it reported done with the gap only in its third paragraph).
 *
 * Each of the three rules is held in every place a session learns it: the charter in the prompt of a
 * worker, a lead and Main (and the operating contract and persona), the messaging skill, the kind a
 * needs ask names, and the readback after every compaction. A reader that loses one fails, and so
 * does a rule that loses the words that make it work.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-scope-kept'))

import { WALNUT_HOME } from '../../src/constants.js'
import {
  NOT_DONE_BY_NAME, REQUEST_READBACK_HEAD, REQUEST_READBACK_MAX, SCOPE_KEPT_MARKS, SCOPE_KEPT_RULE, userRequestReadback,
} from '../../src/core/scope-kept.js'
import { TEAM_CHARTER } from '../../src/core/team-charter.js'
import { buildSessionContext, defaultInstructions } from '../../src/core/sessions/session-context.js'
import { dueChanges, parseInstructions, renderDue } from '../../src/core/sessions/instruction-diff.js'
import { orgSelfWorkRule } from '../../src/core/org/core-instructions.js'
import { changeNodeMemory } from '../../src/core/artifacts/node-memory.js'
import { renderSelfKnowledgeContract } from '../../src/core/self-knowledge-contract.js'
import { buildRoleSection } from '../../src/core/sessions/persona-sections.js'
import { USER_KIND_WORDS } from '../../src/core/org/user-kind.js'
import { addTask, updateTaskRaw } from '../../src/core/task-manager.js'
import { createSessionRecord, updateSessionRecord } from '../../src/core/session-tracker.js'
import { HOOK_CONTEXT_MAX, collectOpenItems } from '../../src/core/sessions/open-items.js'
import { resetCache } from '../../src/core/session-message-queue.js'
import type { Task } from '../../src/core/types.js'

const REPO = path.resolve(__dirname, '../..')

function task(over: Partial<Task>): Task {
  return { id: 'mt-scope-1', title: 'Move the session daemon', project: 'marina', phase: 'IN_PROGRESS', ...over } as Task
}

describe('the three rules', () => {
  it('(a) a cut is the user\'s decision, asked in needs, and silence is not a yes', () => {
    for (const mark of SCOPE_KEPT_MARKS) expect(SCOPE_KEPT_RULE).toContain(mark)
    expect(SCOPE_KEPT_RULE).toMatch(/Doing less than the user asked \(a phase, part or platform of what they set\) is their decision, never yours, however reasonable and even if it could be done later \(the self-check below never decides it\)/)
    expect(SCOPE_KEPT_RULE).toMatch(/ask it in needs \(user_kind user_own\) with your pick/)
    expect(SCOPE_KEPT_RULE).toMatch(/or as a subtask ask your lead, who puts it to them and never decides it/)
    expect(SCOPE_KEPT_RULE).toMatch(/keep doing every part you can meanwhile; no answer is not a yes/)
    // It overrides the decide-it-yourself self-check of the next bullet, which it must stay ahead of.
    expect(TEAM_CHARTER.indexOf(SCOPE_KEPT_RULE)).toBeLessThan(TEAM_CHARTER.indexOf('if I am wrong, can I undo it'))
  })

  it('(b) a compaction\'s summary keeps the User Request verbatim and marks the agent\'s own cuts', () => {
    expect(SCOPE_KEPT_RULE).toMatch(/A compaction's summary copies your note's User Request word for word/)
    expect(SCOPE_KEPT_RULE).toMatch(/each cut you made yourself as your own call they have not agreed to, never as the goal or a fact/)
  })

  it('(c) a report of done lists every part left in not_done, by name, never only in its text', () => {
    expect(NOT_DONE_BY_NAME).toMatch(/anything not done goes in not_done, each phase or part left by name, never only in the text of your report/)
  })

  it('are plain ASCII English with no dash punctuation', () => {
    for (const text of [SCOPE_KEPT_RULE, NOT_DONE_BY_NAME, REQUEST_READBACK_HEAD]) {
      expect(text).toMatch(/^[\x20-\x7e]+$/)
      expect(text).not.toMatch(/ - /)
    }
  })
})

describe('every default prompt carries them', () => {
  it('the charter: (a) and (b) as a bullet of their own, (c) in the done line', () => {
    expect(TEAM_CHARTER).toContain(`\n- ${SCOPE_KEPT_RULE}\n`)
    expect(TEAM_CHARTER).toContain(`check each item; ${NOT_DONE_BY_NAME} A look that turned into work`)
  })

  const roles: Array<[string, Partial<Task>]> = [
    ['worker', {}],
    ['subtask of a leader', { parent_task_id: 'mt-scope-0' }],
    ['project lead', { org_role: 'lead' } as Partial<Task>],
    ['main agent', { org_role: 'main', project: 'Ask Walnut', walnut_agent: true } as Partial<Task>],
  ]
  for (const [label, over] of roles) {
    it(`a ${label}'s session prompt`, async () => {
      const { systemPrompt } = await buildSessionContext('mt-scope-1', '/x', 'h', { task: task(over) })
      expect(systemPrompt).toContain(SCOPE_KEPT_RULE)
      expect(systemPrompt).toContain(NOT_DONE_BY_NAME)
    })
  }

  it('the operating contract and the persona', () => {
    for (const text of [renderSelfKnowledgeContract(), buildRoleSection('Ada')]) {
      expect(text).toContain(SCOPE_KEPT_RULE)
      expect(text).toContain(NOT_DONE_BY_NAME)
    }
  })

  it('the messaging skill lists a cut among the user\'s decisions', () => {
    const skill = fs.readFileSync(path.join(REPO, 'src/data/skills/walnut-session-messaging/SKILL.md'), 'utf8')
    expect(skill).toMatch(/4\. doing less than they asked/)
    expect(skill).toMatch(/no answer is not a yes/)
    expect(skill).toMatch(/User Request word for word/)
    expect(skill).toMatch(/lists every part left in `not_done`, never only in its text/)
  })

  it('the kind the needs ask names covers a cut', () => {
    expect(USER_KIND_WORDS.user_own).toMatch(/doing less than they asked/)
  })
})

describe('what the task was set to do, read back after a compaction', () => {
  const note = (request: string) => `## Executive Summary\nPhase 1 landed.\n\n## User Request\n${request}\n\n## Progress\n- phase 1 done\n`
  const request = 'Move all four phases: 1 the socket, 2 the spawn, 3 the restart, 4 drop the resident daemon.'

  it('the User Request word for word, under a head that says a narrower summary is the agent\'s own call', () => {
    const text = userRequestReadback({ note: note(request), phase: 'IN_PROGRESS' })
    expect(text.startsWith(REQUEST_READBACK_HEAD)).toBe(true)
    expect(text).toContain(`User Request (your restatement of what they set):\n${request}`)
    expect(text).toMatch(/that cut was your own call and the user has not agreed to it/)
  })

  it('and the words the task was created with, when they differ (a restatement the agent narrowed)', () => {
    const asked = 'Do all four phases of the daemon move, phase 4 included.'
    const text = userRequestReadback({ note: note('Phase 1 only.'), description: `${asked}\n\nMore context.`, phase: 'IN_PROGRESS' })
    expect(text).toContain(`The words the task was created with:\n${asked}`)
    expect(text).not.toContain('More context.')
    expect(userRequestReadback({ note: note(asked), description: asked, phase: 'IN_PROGRESS' })).not.toContain('created with')
    expect(userRequestReadback({ description: asked, phase: 'IN_PROGRESS' })).toContain(asked)
  })

  it('nothing for a task with neither, or a completed one', () => {
    expect(userRequestReadback({ note: '## Progress\n- x\n', phase: 'IN_PROGRESS' })).toBe('')
    expect(userRequestReadback({ phase: 'IN_PROGRESS' })).toBe('')
    expect(userRequestReadback({ note: note('Do it all.'), phase: 'COMPLETE' })).toBe('')
  })

  it('within the room it is given: cut at a line end with a pointer, or only a pointer', () => {
    const long = Array.from({ length: 80 }, (_, i) => `- item ${i}: one more part of what the user set, in his own words.`).join('\n')
    const full = userRequestReadback({ note: note(long), phase: 'IN_PROGRESS' })
    expect(full.length).toBeLessThanOrEqual(REQUEST_READBACK_MAX)
    expect(full).toContain('- item 0:')
    expect(full.endsWith('(Cut here: task_get reads the whole note and description.)')).toBe(true)
    const small = userRequestReadback({ note: note(long), phase: 'IN_PROGRESS' }, 900)
    expect(small.length).toBeLessThanOrEqual(900)
    expect(small).toContain('- item 0:')
    const none = userRequestReadback({ note: note(long), phase: 'IN_PROGRESS' }, 100)
    expect(none).toBe(`${REQUEST_READBACK_HEAD} (Cut here: task_get reads the whole note and description.)`)
  })

  describe('in the compaction hook (open_items)', () => {
    beforeEach(async () => {
      await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
      await fsp.mkdir(WALNUT_HOME, { recursive: true })
      resetCache()
    })

    for (const role of [undefined, 'lead', 'main'] as const) {
      it(`a ${role ?? 'worker'}'s hook carries it and leaves the rest its room`, async () => {
        const { task: t } = await addTask({ title: 'Move', project: role === 'main' ? 'Ask Walnut' : 'marina', ...(role ? { org_role: role } : {}) })
        const long = Array.from({ length: 80 }, (_, i) => `- item ${i}: one more part of what the user set, in his own words.`).join('\n')
        await updateTaskRaw(t.id, { note: note(`${request}\n${long}`) })
        // A MEMORY.md after it: the restatement's tail, which a readback must not push out.
        await changeNodeMemory(t.id, () => ({ text: '- memory line 0: kept after the readback.', at: new Date().toISOString() }))
        const sid = randomUUID()
        await createSessionRecord(sid, t.id, t.project, WALNUT_HOME)
        await updateSessionRecord(sid, { appliedAppendSystemPrompt: (await buildSessionContext(t.id)).systemPrompt })
        const hook = await collectOpenItems(sid, Date.now(), { afterCompaction: true })
        expect(hook.text).toContain(REQUEST_READBACK_HEAD)
        expect(hook.text).toContain(request)
        // A worker's MEMORY.md comes in this hook; Main's or a lead's in its own hook (own-readback.ts),
        // and their core instructions here, whole.
        if (role) expect(hook.text).toContain(orgSelfWorkRule(role))
        else expect(hook.text).toContain('memory line 0: kept after the readback.')
        expect(hook.text.length).toBeLessThanOrEqual(HOOK_CONTEXT_MAX)
        // open_items outside a compaction is the agent's own look: it reads the note itself with task_get.
        expect((await collectOpenItems(sid, Date.now())).text).not.toContain(REQUEST_READBACK_HEAD)
      })
    }
  })
})

describe('a session spawned before these rules hears only them', () => {
  it('the notice carries the new bullet and the reworded done line, no other line', () => {
    const now = defaultInstructions(task({}))
    const old = now.replace(`\n- ${SCOPE_KEPT_RULE}`, '').replace(NOT_DONE_BY_NAME, 'anything not done goes in not_done.')
    expect(old).not.toBe(now)
    const due = dueChanges(parseInstructions(now), parseInstructions(old), new Set(), {}, {})
    const text = due ? renderDue(due) : ''
    const bullets = text.split('\n').filter((l) => l.startsWith('- '))
    expect(bullets).toHaveLength(2)
    expect(bullets[0]).toContain(NOT_DONE_BY_NAME)
    expect(bullets[1]).toBe(`- ${SCOPE_KEPT_RULE}`)
    expect(Buffer.byteLength(text)).toBeLessThan(1_500)
  })
})
