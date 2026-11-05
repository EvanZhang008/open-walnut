/**
 * src/lib/id-ref.ts: an id given in full names that item even when it is the
 * start of a longer id; only a reference no id equals is read as a prefix.
 */
import { describe, it, expect } from 'vitest'
import { ambiguousIdMessage, idRefErrorStatus, matchIdRef, matchParentRef, missingIsNull, refNamesId } from '../../src/lib/id-ref.js'

const SHORT = { id: 'fixa83e-d669' }
const LONG = { id: 'fixa83e-d6690' }
const OTHER = { id: 'fixb12c-0001' }
const ITEMS = [LONG, SHORT, OTHER]

describe('matchIdRef', () => {
  it('answers the exact item alone when a longer id starts with it', () => {
    expect(matchIdRef(ITEMS, SHORT.id)).toEqual([SHORT])
    expect(matchIdRef([SHORT, LONG], SHORT.id)).toEqual([SHORT])
    expect(matchIdRef(ITEMS, LONG.id)).toEqual([LONG])
  })

  it('still resolves a unique prefix', () => {
    expect(matchIdRef(ITEMS, 'fixb')).toEqual([OTHER])
  })

  it('still answers every item an ambiguous prefix names', () => {
    expect(matchIdRef(ITEMS, 'fixa83e')).toEqual([LONG, SHORT])
    expect(matchIdRef(ITEMS, 'fix')).toHaveLength(3)
  })

  it('names nothing for an empty or unknown reference', () => {
    expect(matchIdRef(ITEMS, '')).toEqual([])
    expect(matchIdRef(ITEMS, 'nope')).toEqual([])
    expect(matchIdRef([], 'fix')).toEqual([])
  })

  it('reads ids through idOf and takes any iterable', () => {
    const sessions = [{ sid: 'AB12cd34-1' }, { sid: 'ab12cd34' }]
    expect(matchIdRef(sessions, 'ab12cd34', (s) => s.sid.toLowerCase())).toEqual([sessions[1]])
    expect(matchIdRef(new Set(['ab', 'abc']), 'ab', (id) => id)).toEqual(['ab'])
    const map = new Map([['ab', 1], ['abc', 2]])
    expect(matchIdRef(map, 'ab', ([key]) => key)).toEqual([['ab', 1]])
  })
})

describe('refNamesId (a stored reference such as parent_task_id)', () => {
  it('a whole id names only itself', () => {
    expect(refNamesId(SHORT.id, SHORT.id, true)).toBe(true)
    expect(refNamesId(SHORT.id, LONG.id, true)).toBe(false)
  })

  it('a legacy prefix no id equals names every id it starts', () => {
    expect(refNamesId('fixa83e', SHORT.id, false)).toBe(true)
    expect(refNamesId('fixa83e', LONG.id, false)).toBe(true)
    expect(refNamesId('fixa83e', OTHER.id, false)).toBe(false)
  })

  it('an empty or missing reference names nothing', () => {
    expect(refNamesId('', SHORT.id, false)).toBe(false)
    expect(refNamesId(undefined, SHORT.id, false)).toBe(false)
    expect(refNamesId(null, SHORT.id, false)).toBe(false)
  })
})

describe('matchParentRef: a parent reference never names its own holder', () => {
  // The subtask's id starts with its parent's whole id, as `-tour` and `-tour-phone` do.
  const PARENT = { id: 'fixtour', parent_task_id: undefined as string | undefined }
  const CHILD = { id: 'fixtour-phone', parent_task_id: 'fixtour' }
  const GRANDCHILD = { id: 'fixtour-phone-2', parent_task_id: 'fixtour-phone' }

  it('finds the parent when it is in the list', () => {
    expect(matchParentRef([CHILD, PARENT], CHILD)).toBe(PARENT)
  })

  it('a parent left out of the list (completed, filtered) is nothing, never the child itself', () => {
    expect(matchParentRef([CHILD], CHILD)).toBeUndefined()
    expect(matchParentRef([CHILD, GRANDCHILD], CHILD, { knownIds: new Set([PARENT.id, CHILD.id, GRANDCHILD.id]) })).toBeUndefined()
  })

  it('without knownIds a legacy short reference still finds the one task it starts', () => {
    expect(matchParentRef([PARENT, CHILD], { id: 'x-1', parent_task_id: 'fixt' })).toBe(PARENT)
    expect(matchParentRef([CHILD], { id: CHILD.id, parent_task_id: 'fixt' })).toBeUndefined()
  })

  it('a reference to itself or none names nothing', () => {
    expect(matchParentRef([CHILD], { id: CHILD.id, parent_task_id: CHILD.id })).toBeUndefined()
    expect(matchParentRef([PARENT], { id: 'x', parent_task_id: '' })).toBeUndefined()
  })

  it('refNamesId skips the holder of the reference', () => {
    expect(refNamesId('fixtour', CHILD.id, false)).toBe(true)
    expect(refNamesId('fixtour', CHILD.id, false, CHILD.id)).toBe(false)
    expect(refNamesId('fixtour', 'fixtour', true, CHILD.id)).toBe(true)
  })
})

describe('the words and status of an id lookup that fails', () => {
  it('maps an ambiguous prefix and a bad parent to 400, a missing id to 404', () => {
    expect(idRefErrorStatus(ambiguousIdMessage('fix', [{ id: 'fixa' }, { id: 'fixb' }]))).toBe(400)
    expect(idRefErrorStatus('Ambiguous parent_task_id prefix: fix')).toBe(400)
    expect(idRefErrorStatus('Parent task not found: nope')).toBe(400)
    expect(idRefErrorStatus('No task found matching ID prefix "nope"')).toBe(404)
    expect(idRefErrorStatus('Task not found: nope')).toBe(404)
    expect(idRefErrorStatus('Cannot pin a completed task: x')).toBeNull()
  })

  it('names the first three matches and asks for the whole id', () => {
    const many = ['fix1', 'fix2', 'fix3', 'fix4'].map((id) => ({ id }))
    expect(ambiguousIdMessage('fix', many)).toBe('Ambiguous ID prefix "fix" matches 4 tasks (fix1, fix2, fix3, ...): give the whole id.')
    expect(ambiguousIdMessage('fix', many.slice(0, 2))).toBe('Ambiguous ID prefix "fix" matches 2 tasks (fix1, fix2): give the whole id.')
  })

  it('missingIsNull reads a missing task as null and throws on an ambiguous one', () => {
    expect(missingIsNull(new Error('No task found matching ID prefix "nope"'))).toBeNull()
    expect(() => missingIsNull(new Error(ambiguousIdMessage('fix', [{ id: 'fixa' }, { id: 'fixb' }])))).toThrow(/Ambiguous/)
  })
})
