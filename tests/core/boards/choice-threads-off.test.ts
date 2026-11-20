/**
 * Board choices as threads with the experiment off (src/core/boards/choice-threads.ts): off must
 * cost nothing where no choice ever had a thread.
 *
 *   1. Off, with no choice thread anywhere: the boot sweep (run off too) and a Board event read
 *      no Board and no task list.
 *   2. Off, with a choice thread on one Board: the sweep and that Board's events sync that Board
 *      only; another Board's event still does nothing.
 */
import { describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-choice-threads-off'))

const work = vi.hoisted(() => ({
  getBoard: vi.fn(async (_id: string) => null),
  listBoardTaskIds: vi.fn(async () => ['task-held', 'task-other']),
  listTasks: vi.fn(async () => [] as unknown[]),
  threads: [] as Array<Record<string, unknown>>,
}))

vi.mock('../../../src/core/org/brief-off.js', () => ({
  briefOffOn: async () => false,
  briefOffNow: () => false,
  briefOffFlag: { now: () => false, on: async () => false, set: () => {} },
}))
vi.mock('../../../src/core/boards/board-store.js', () => ({
  getBoard: work.getBoard,
  hasBoard: async () => false,
  listBoardTaskIds: work.listBoardTaskIds,
}))
vi.mock('../../../src/core/task-manager.js', () => ({
  listTasks: work.listTasks,
  listTasksByIds: async () => [],
}))
vi.mock('../../../src/core/org/threads-store.js', () => ({
  threadTaskIds: async () => (work.threads.length ? ['task-held'] : []),
  readThreads: async (taskId: string) => ({ version: 1, task_id: taskId, threads: taskId === 'task-held' ? work.threads : [] }),
  threadHolder: async (taskId: string, id: string) => {
    const t = work.threads.find((x) => x.id === id)
    return t && taskId === 'task-held' ? { node: taskId, thread: t } : null
  },
  writeThreadsFor: async (_taskId: string, mutate: (cur: unknown) => { out: unknown }) => mutate({ version: 1, task_id: 'task-held', threads: work.threads }).out,
}))

import { bus, EventNames } from '../../../src/core/event-bus.js'
import { startChoiceThreads, syncAllChoiceThreads } from '../../../src/core/boards/choice-threads.js'

const boardEvent = (taskId: string) => bus.emit(EventNames.BOARD_CHANGED, { taskId, kind: 'html' }, ['*'])
const settle = () => new Promise((r) => setTimeout(r, 100))
const boardsRead = () => work.getBoard.mock.calls.map((c) => c[0])

describe('choice threads with the experiment off', () => {
  it('no choice thread anywhere: the boot sweep and a Board event do no work', async () => {
    const handle = startChoiceThreads({ firstMs: 0 })
    try {
      await settle()
      await settle()
      boardEvent('task-other')
      await settle()
      expect(work.getBoard).not.toHaveBeenCalled()
      expect(work.listTasks).not.toHaveBeenCalled()
      expect(work.listBoardTaskIds).not.toHaveBeenCalled()

      // A choice thread on one Board: only that Board is synced, by the sweep and by its events.
      work.threads.push({ id: 'th-choice-held', title: 'Cedar or pine?', state: 'needs', choice: { board: 'task-held', id: 'fence', options: [{ value: 'cedar', label: 'Cedar' }] } })
      await syncAllChoiceThreads()
      expect(boardsRead()).toEqual(['task-held'])
      expect(work.listBoardTaskIds).not.toHaveBeenCalled()
      boardEvent('task-other')
      await settle()
      expect(boardsRead()).toEqual(['task-held'])
      boardEvent('task-held')
      await vi.waitFor(() => expect(boardsRead()).toEqual(['task-held', 'task-held']), { timeout: 5000 })
    } finally {
      handle.stop()
    }
  })
})
