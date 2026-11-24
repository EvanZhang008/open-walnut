/**
 * Tasks like the one being typed (DraftTaskMatches): the query is the first line, the search's
 * matches come first, titles that hold every word follow, open before done, at most four.
 */
import { describe, expect, it } from 'vitest'
import type { Task } from '@open-walnut/core'
import { matchQuery, pickMatches } from '../../web/src/components/sessions/DraftTaskMatches'

const task = (id: string, title: string, extra: Partial<Task> = {}): Task =>
  ({ id, title, project: 'marina', status: 'todo', phase: 'TODO', ...extra }) as Task

describe('draft task matches', () => {
  it('reads the first line from three characters on', () => {
    expect(matchQuery('fi')).toBe('')
    expect(matchQuery('  fix login  \nmore detail')).toBe('fix login')
    expect(matchQuery('\nsecond line only')).toBe('')
  })

  it('literal hits first (the board\'s rule: the query in a title), then the search\'s hits that show it; four at most', () => {
    const tasks = [
      task('a', 'Fix login timeout on review'),
      task('c', 'Unrelated chore'),
      task('d', 'Phone: fix login timeout'),
      task('e', 'FIX LOGIN TIMEOUT again'),
      task('f', 'fix login timeout, once more'),
      task('g', 'fix login timeout, the last one'),
    ]
    const got = pickMatches(tasks, 'fix login timeout', ['c', 'a'])
    expect(got.map((m) => m.id)).toEqual(['a', 'd', 'e', 'f'])
    expect(got.every((m) => m.literal)).toBe(true)
    expect(pickMatches(tasks, 'chore list', ['c']).map((m) => [m.id, m.literal])).toEqual([['c', false]])
    expect(pickMatches(tasks, '', ['a'])).toEqual([])
  })

  it('a done literal hit comes after the open ones', () => {
    const tasks = [task('b', 'Login fix', { status: 'done', phase: 'COMPLETE' }), task('a', 'Login fix two')]
    expect(pickMatches(tasks, 'login fix', null).map((m) => m.id)).toEqual(['a', 'b'])
  })

  it('a search id the list does not hold is skipped', () => {
    expect(pickMatches([task('a', 'Alpha')], 'zzz', ['missing'])).toEqual([])
  })
})
