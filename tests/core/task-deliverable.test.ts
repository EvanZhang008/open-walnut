/**
 * A task's deliverable in one line (src/core/task-deliverable.ts), shown at the top of task_get so
 * a lead reads what an existing task was made to produce before it hands that task new work.
 */
import { describe, expect, it } from 'vitest'
import { DELIVERABLE_MAX, deliverableLine } from '../../src/core/task-deliverable.js'
import { getOp } from '../../src/ops/registry.js'

describe('deliverableLine', () => {
  it('reads the note\'s User Request first, as one line without markdown', () => {
    const note = '## Executive Summary\nMerged, rolling out.\n\n## User Request\nFrom the watch leader:\n- **CR 1** adds only `s3:ListBucket`.\n- CR 2 adds alarm dimensions.\n- (Former) the outage fix: moved to another task.\n\n## Progress\n- [DONE] CR 1'
    expect(deliverableLine({ title: 'CR: poller', note })).toBe('From the watch leader: CR 1 adds only s3:ListBucket. CR 2 adds alarm dimensions.')
  })

  it('an old note\'s "## Goal" counts as its User Request', () => {
    expect(deliverableLine({ title: 'x', note: '## Goal\nShip the export button.' })).toBe('Ship the export button.')
  })

  it('falls back to the description\'s first paragraph, then the title', () => {
    expect(deliverableLine({ title: 'T', description: 'Fix the login loop.\n\nBackground: long.' })).toBe('Fix the login loop.')
    expect(deliverableLine({ title: 'Repaint the garden fence', note: 'free-form note' })).toBe('Repaint the garden fence')
    expect(deliverableLine({})).toBe('')
  })

  it('clips a long request at a word', () => {
    const line = deliverableLine({ note: `## User Request\n${'word '.repeat(200)}` })
    expect(line.length).toBeLessThanOrEqual(DELIVERABLE_MAX + 1)
    expect(line.endsWith('word…')).toBe(true)
  })
})

describe('task_get', () => {
  it('puts the deliverable beside the title at the top of its answer', async () => {
    await import('../../src/ops/index.js')
    const map = getOp('task_get')!.mapResult!
    const out = map({
      body: { task: { id: 'mabc0001-aaaa', title: 'CR: poller', phase: 'IN_PROGRESS', note: '## User Request\nCR 1 adds only ListBucket.' } },
      args: { id: 'mabc0001' },
    }) as Record<string, unknown>
    expect(Object.keys(out).slice(0, 4)).toEqual(['id', 'title', 'phase', 'deliverable'])
    expect(out.deliverable).toBe('CR 1 adds only ListBucket.')
  })
})
