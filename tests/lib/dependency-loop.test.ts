import { describe, it, expect } from 'vitest'
import { dependsOnThrough } from '../../src/lib/dependency-loop'

describe('dependsOnThrough: the one rule for a dependency loop', () => {
  const tasks = [
    { id: 'a', depends_on: ['b'] },
    { id: 'b', depends_on: ['c'] },
    { id: 'c' },
    { id: 'd', depends_on: ['d2'] },
    { id: 'd2', depends_on: ['d'] },
  ]
  it('a direct and a transitive dependency both count', () => {
    expect(dependsOnThrough(tasks, 'a', 'b')).toBe(true)
    expect(dependsOnThrough(tasks, 'a', 'c')).toBe(true)
  })
  it('the other way round, or an unrelated task, does not', () => {
    expect(dependsOnThrough(tasks, 'c', 'a')).toBe(false)
    expect(dependsOnThrough(tasks, 'a', 'd')).toBe(false)
  })
  it('a loop already in the data ends the walk', () => {
    expect(dependsOnThrough(tasks, 'd', 'a')).toBe(false)
  })
  it('a task missing from the list ends its branch', () => {
    expect(dependsOnThrough([{ id: 'x', depends_on: ['gone'] }], 'x', 'y')).toBe(false)
  })
})
