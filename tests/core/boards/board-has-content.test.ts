/**
 * boardHasContent: what makes a task one that keeps a Board (the session
 * header's Board tab, GET /tasks/:id/board/owner?tab=1). Only what a person or
 * an agent wrote counts; looking at a board and the server's own kanban stamps
 * do not.
 */
import { describe, it, expect } from 'vitest'
import { boardHasContent, emptyBoard, type BoardFile } from '../../../src/core/boards/board-store.js'

const base = (): BoardFile => emptyBoard('t1', 'human')

describe('boardHasContent', () => {
  it('no board, or an empty one, has none', () => {
    expect(boardHasContent(null)).toBe(false)
    expect(boardHasContent(base())).toBe(false)
    expect(boardHasContent({ ...base(), html: '   \n' })).toBe(false)
  })

  it('only looking leaves no content: a seen baseline, a seen section', () => {
    expect(boardHasContent({ ...base(), kanban_seen: { at: '2026-10-26T00:00:00Z', cards: {} } as unknown as BoardFile['kanban_seen'] })).toBe(false)
    expect(boardHasContent({ ...base(), section_seen: { s1: { hash: 'h', at: '2026-10-26T00:00:00Z' } } })).toBe(false)
  })

  it('the server\'s kanban bookkeeping is not content: a materialized template, automatic card stamps', () => {
    expect(boardHasContent({ ...base(), lanes: [{ id: 'todo', title: 'To do', kind: 'todo' }] as unknown as BoardFile['lanes'] })).toBe(false)
    expect(boardHasContent({ ...base(), cards: { w1: { lane_auto: { lane: 'done', at: 'x' }, handed_back_at: 'x', output_at: 'x', worker_summary_at: 'x' } } })).toBe(false)
  })

  it('a page, a thread, a mark, a project, a choice, edited lanes or a placed card is content', () => {
    expect(boardHasContent({ ...base(), html: '<h1>Plan</h1>' })).toBe(true)
    expect(boardHasContent({ ...base(), threads: { a: [] } })).toBe(true)
    expect(boardHasContent({ ...base(), marks: { m: { note: 'x' } as unknown as BoardFile['marks'][string] } })).toBe(true)
    expect(boardHasContent({ ...base(), projects: { p: {} as BoardFile['projects'][string] } })).toBe(true)
    expect(boardHasContent({ ...base(), choices: { c: {} as BoardFile['choices'][string] } })).toBe(true)
    expect(boardHasContent({ ...base(), lanes: [] as unknown as BoardFile['lanes'], lanes_by: 'human' })).toBe(true)
    expect(boardHasContent({ ...base(), cards: { w1: { lane: 'review', lane_by: 'human' } } })).toBe(true)
    expect(boardHasContent({ ...base(), cards: { w1: { rank: 2, rank_lane: 'todo' } } })).toBe(true)
    expect(boardHasContent({ ...base(), cards: { w1: { summary: 's', summary_by: 'task:x' } as never } })).toBe(true)
  })
})
