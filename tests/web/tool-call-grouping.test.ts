/**
 * Phone timeline folding (spec 4.5, 4.7; C69, C84): runs of consecutive tool
 * calls read as one row, and a long command keeps its first and last lines.
 */
import { describe, it, expect } from 'vitest'
import {
  foldLongCommand, groupToolCalls, toolCallsLabel, type ToolRunItem,
} from '../../web/src/components/sessions/tool-call-grouping'

const t = (kind: ToolRunItem['kind']): ToolRunItem => ({ kind })

describe('groupToolCalls', () => {
  it('folds 20 consecutive tool calls into one run', () => {
    const groups = groupToolCalls(Array.from({ length: 20 }, () => t('tool')))
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ kind: 'tools', start: 0, toolCount: 20 })
  })

  it('text from the assistant between calls ends the run', () => {
    const groups = groupToolCalls([t('tool'), t('tool'), t('text'), t('tool')])
    expect(groups.map((g) => g.kind)).toEqual(['tools', 'single', 'tools'])
    expect(groups[0]).toMatchObject({ toolCount: 2, start: 0 })
    expect(groups[2]).toMatchObject({ toolCount: 1, start: 3 })
  })

  it('reasoning between calls stays inside the run and is not counted', () => {
    const groups = groupToolCalls([t('tool'), t('thinking'), t('tool'), t('thinking')])
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ kind: 'tools', toolCount: 2 })
    if (groups[0]!.kind === 'tools') expect(groups[0]!.items).toHaveLength(4)
  })

  it('reasoning alone is not a run', () => {
    const groups = groupToolCalls([t('text'), t('thinking'), t('text')])
    expect(groups.map((g) => g.kind)).toEqual(['single', 'single', 'single'])
    expect(groups.map((g) => (g.kind === 'single' ? g.index : -1))).toEqual([0, 1, 2])
  })

  it('an empty timeline has no groups', () => {
    expect(groupToolCalls([])).toEqual([])
  })
})

describe('toolCallsLabel', () => {
  it('counts in words', () => {
    expect(toolCallsLabel(1)).toBe('1 tool call')
    expect(toolCallsLabel(20)).toBe('20 tool calls')
    expect(toolCallsLabel(0)).toBe('0 tool calls')
  })
})

describe('foldLongCommand', () => {
  it('keeps a short command whole', () => {
    expect(foldLongCommand('a\nb\nc')).toEqual({ folded: false, head: ['a', 'b', 'c'], tail: [], total: 3 })
    expect(foldLongCommand('1\n2\n3\n4\n5\n6').folded).toBe(false)
  })

  it('shows the first 3 and the last 3 lines of a 20-line command', () => {
    const lines = Array.from({ length: 19 }, (_, i) => `step ${i + 1}`).concat('echo end-marker')
    const f = foldLongCommand(lines.join('\n'))
    expect(f.folded).toBe(true)
    expect(f.total).toBe(20)
    expect(f.head).toEqual(['step 1', 'step 2', 'step 3'])
    expect(f.tail).toEqual(['step 18', 'step 19', 'echo end-marker'])
  })

  it('a trailing newline and CRLF endings are not extra lines', () => {
    const f = foldLongCommand('1\r\n2\r\n3\r\n4\r\n5\r\n6\r\n7\n\n')
    expect(f.total).toBe(7)
    expect(f.tail).toEqual(['5', '6', '7'])
  })
})
