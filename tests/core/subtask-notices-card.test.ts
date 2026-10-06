/**
 * G19 in subtask notices (src/core/sessions/subtask-notices.ts): a `stopped`
 * or `completed` notice to a parent that has a Board names the child's card
 * lane, inside the envelope before its Next list; other kinds, and a parent
 * with no board, get nothing (C79). Real tasks and board files in an isolated home.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-subtask-notices-card'))

import { WALNUT_HOME } from '../../src/constants.js'
import { addTask, linkSessionSlot, updateTask } from '../../src/core/task-manager.js'
import { setBoardHtml } from '../../src/core/boards/board-store.js'
import { moveBoardCard } from '../../src/core/boards/board-kanban.js'
import {
  attachCardLine, boardCardLine, buildSubtaskNoticeText, type SubtaskNotice,
} from '../../src/core/sessions/subtask-notices.js'

async function task(title: string, parent?: string, tags?: string[]): Promise<string> {
  const { task: t } = await addTask({ title, project: 'acme', ...(parent ? { parent_task_id: parent } : {}), ...(tags ? { tags } : {}) })
  return t.id
}

let owner: string
let worker: string
let bare: string
let bareKid: string

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  owner = await task('Payments resolver group')
  worker = await task('V1000000501 refund stuck', owner, ['ticket:V1000000501'])
  await linkSessionSlot(worker, 'aaaaaaaa-0000-0000-0000-000000000501', 'exec')
  await updateTask(worker, { phase: 'NEED_ACTION' })
  await setBoardHtml(owner, '<h1>Team</h1>', { by: 'human' })
  bare = await task('Leader with no board')
  bareKid = await task('Kid of that leader', bare)
})

afterAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

const notice = (kind: SubtaskNotice['kind'], parent = owner, child = worker): SubtaskNotice =>
  ({ parentTaskId: parent, child: { id: child, title: 'V1000000501 refund stuck' }, kind })

describe('the card line in subtask notices', () => {
  it('names the lane the card shows in now (a worker that had a session is in Investigating)', async () => {
    expect(await boardCardLine(owner, worker))
      .toBe('Card: Investigating. Update it with board_card_set if the ticket moved or its summary changed.')
    await moveBoardCard(owner, worker, { lane: 'waiting-cr', order: [worker] }, { by: 'human' })
    expect(await boardCardLine(owner, worker)).toMatch(/^Card: Waiting on CR\. /)
  })

  it('stopped and completed get it, inside the envelope before Next; error, blocked and waiting do not', async () => {
    const stopped = await attachCardLine(notice('stopped'))
    expect(stopped.cardLine).toMatch(/^Card: /)
    const text = buildSubtaskNoticeText(stopped)
    const card = text.indexOf('Card: Waiting on CR.')
    expect(card).toBeGreaterThan(text.indexOf('stopped without completing'))
    expect(card).toBeLessThan(text.lastIndexOf('Next:'))
    expect(text.trimEnd().endsWith('</walnut-message>')).toBe(true)
    expect((await attachCardLine(notice('completed'))).cardLine).toMatch(/^Card: /)
    for (const kind of ['error', 'blocked', 'waiting'] as const) {
      const n = await attachCardLine(notice(kind))
      expect(n.cardLine).toBeUndefined()
      expect(buildSubtaskNoticeText(n)).not.toContain('board_card_set')
    }
  })

  it('a parent with no board gets no line, and the text is exactly what it was before', async () => {
    expect(await boardCardLine(bare, bareKid)).toBe('')
    const n = await attachCardLine(notice('stopped', bare, bareKid))
    expect(n.cardLine).toBeUndefined()
    expect(buildSubtaskNoticeText(n)).toBe(buildSubtaskNoticeText(notice('stopped', bare, bareKid)))
    expect(buildSubtaskNoticeText(n)).not.toContain('Card:')
  })
})
