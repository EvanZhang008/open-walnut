/**
 * Task links a sync plugin carries as 8-character id prefixes (the To Do body's `Parent:` and
 * `DependsOn:` headers) resolve back to full ids, on a pull and for rows already written
 * (src/core/pulled-patch.ts). 2026-10-26: the pull wrote "abcd1234" over a local
 * "abcd1234-0001", and the task fell out of its lead's team.
 */
import { describe, expect, it } from 'vitest'
import { idIndex, keepLocalText, prefixLinkRepairs, resolveLink, resolvePulledLinks } from '../../src/core/pulled-patch.js'

const tasks = [
  { id: 'abcd1234-0001' }, // the lead
  { id: 'twin5678-0001' }, { id: 'twin5678-0002' }, // two ids sharing one prefix
  { id: 'work0001-0001', parent_task_id: 'abcd1234-0001' },
  { id: 'dep00001-0001' },
]
const index = idIndex(tasks)

describe('resolveLink', () => {
  it('keeps a full id, keeps the held link a prefix points at, resolves a unique prefix, refuses an ambiguous one', () => {
    expect(resolveLink('abcd1234-0001', undefined, index)).toBe('abcd1234-0001')
    expect(resolveLink('twin5678', 'twin5678-0002', index)).toBe('twin5678-0002')
    expect(resolveLink('abcd1234', undefined, index)).toBe('abcd1234-0001')
    expect(resolveLink('twin5678', undefined, index)).toBeUndefined()
    expect(resolveLink('nothing1', undefined, index)).toBeUndefined()
  })
})

describe('resolvePulledLinks', () => {
  const worker = tasks[3]
  it('a pulled prefix never overwrites the full parent id the task holds', () => {
    const out = resolvePulledLinks({ title: 'x', parent_task_id: 'abcd1234' }, worker, index)
    expect(out).toEqual({ title: 'x', parent_task_id: 'abcd1234-0001' })
  })
  it('a new task from the remote gets the full id of its unique parent', () => {
    expect(resolvePulledLinks({ parent_task_id: 'abcd1234' }, undefined, index).parent_task_id).toBe('abcd1234-0001')
  })
  it('a prefix that matches no single task changes nothing, and a task is never its own parent', () => {
    expect(resolvePulledLinks({ title: 'x', parent_task_id: 'twin5678' }, worker, index)).toEqual({ title: 'x' })
    expect(resolvePulledLinks({ parent_task_id: 'work0001' }, worker, index)).toEqual({})
  })
  it('dependency prefixes resolve one by one; one that cannot be told yet is kept as written', () => {
    expect(resolvePulledLinks({ depends_on: ['dep00001', 'abcd1234-0001'] }, worker, index).depends_on).toEqual(['dep00001-0001', 'abcd1234-0001'])
    expect(resolvePulledLinks({ depends_on: ['dep00001', 'twin5678'] }, worker, index).depends_on).toEqual(['dep00001-0001', 'twin5678'])
    expect(resolvePulledLinks({ depends_on: ['twin5678'] }, { ...worker, depends_on: ['twin5678-0002'] }, index).depends_on).toEqual(['twin5678-0002'])
  })
  it('a parent pulled later in the same tick: the prefix is kept for the next tick\'s repair, never over a held link', () => {
    expect(resolvePulledLinks({ parent_task_id: 'late0001' }, { id: 'n1' }, index).parent_task_id).toBe('late0001')
    expect(resolvePulledLinks({ parent_task_id: 'late0001' }, undefined, index).parent_task_id).toBe('late0001')
  })
  it('a patch with full ids passes through untouched (same object)', () => {
    const patch = { parent_task_id: 'abcd1234-0001', depends_on: ['dep00001-0001'] }
    expect(resolvePulledLinks(patch, worker, index)).toBe(patch)
  })
})

describe('prefixLinkRepairs', () => {
  it('repairs rows already written with a prefix, leaves ambiguous and full ones alone', () => {
    const rows = [
      ...tasks,
      { id: 'kid00001-0001', parent_task_id: 'abcd1234' },
      { id: 'kid00002-0001', parent_task_id: 'twin5678' },
      { id: 'kid00003-0001', depends_on: ['dep00001', 'twin5678'] },
    ]
    const fixes = prefixLinkRepairs(rows)
    expect([...fixes.keys()].sort()).toEqual(['kid00001-0001', 'kid00003-0001'])
    expect(fixes.get('kid00001-0001')).toEqual({ parent_task_id: 'abcd1234-0001' })
    expect(fixes.get('kid00003-0001')).toEqual({ depends_on: ['dep00001-0001', 'twin5678'] })
  })
})

describe('keepLocalText', () => {
  it('a pull never empties a local description, summary or note, and passes real text through', () => {
    const local = { id: 'a', description: 'The request this task starts from.', summary: 'Shipped.', note: '' }
    expect(keepLocalText({ description: '', summary: '  ', note: '', title: 'T' }, local)).toEqual({ note: '', title: 'T' })
    expect(keepLocalText({ description: 'Edited remotely.' }, local)).toEqual({ description: 'Edited remotely.' })
    const untouched = { title: 'T' }
    expect(keepLocalText(untouched, local)).toBe(untouched)
    expect(keepLocalText({ description: '' }, undefined)).toEqual({ description: '' })
  })
  it('undoes the older misread: the description that came back clears the note holding the same text', () => {
    const damaged = { id: 'a', description: '', note: 'The request.' }
    expect(keepLocalText({ description: 'The request.', note: '' }, damaged)).toEqual({ description: 'The request.', note: '' })
    // A different note is the user's own and stays.
    expect(keepLocalText({ description: 'The request.', note: '' }, { ...damaged, note: 'Other.' })).toEqual({ description: 'The request.' })
  })
})
