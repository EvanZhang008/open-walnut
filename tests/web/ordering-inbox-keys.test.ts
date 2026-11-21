/**
 * The server names the Inbox's slot in the project order `Inbox` (every task has a project), the
 * board keys the Inbox's group '' (projectGroupKey). fetchOrdering reads both under the board's
 * key, so a hand-placed line next to the Inbox stays where it was drawn.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../web/src/api/client', () => ({
  apiGet: vi.fn(async () => ({
    projects: ['Garden', 'Inbox', 'Reading'],
    separators: [
      { id: 'a', tier: 'focus', mode: 'project', afterProject: 'Garden', beforeProject: 'Inbox' },
      { id: 'b', tier: 'focus', mode: 'project', afterProject: 'inbox', beforeProject: 'Reading' },
      { id: 'c', tier: 'focus', mode: 'project', project: 'Inbox' },
      { id: 'd', tier: 'focus', mode: 'custom', afterTaskId: 't1', beforeTaskId: 't2' },
    ],
  })),
  apiPut: vi.fn(),
}))

import { fetchOrdering } from '../../web/src/api/ordering'

describe('fetchOrdering', () => {
  it('reads the Inbox under the board key in the project order and every project-mode anchor', async () => {
    const o = await fetchOrdering()
    expect(o.projects).toEqual(['Garden', '', 'Reading'])
    expect(o.separators).toEqual([
      { id: 'a', tier: 'focus', mode: 'project', afterProject: 'Garden', beforeProject: '' },
      { id: 'b', tier: 'focus', mode: 'project', afterProject: '', beforeProject: 'Reading' },
      { id: 'c', tier: 'focus', mode: 'project', project: '' },
      { id: 'd', tier: 'focus', mode: 'custom', afterTaskId: 't1', beforeTaskId: 't2' },
    ])
  })
})
