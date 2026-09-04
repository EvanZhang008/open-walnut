/**
 * pickBatchUuid — the drain rule for pre-assigned user-message uuids.
 *
 * A drain joins every pending row into ONE stream-json user message, so only one
 * uuid can survive. The harness's own enqueue path takes `batch.findLast(c =>
 * c.uuid)`, and Walnut ports that verbatim: the LAST uuid in the batch wins.
 *
 * Would-fail-if-reverted: switch the helper to `find` (first-wins) and the
 * "several uuids" case fails; return a fallback uuid for an empty batch and the
 * "no uuids" case fails, which is the one that keeps the FIFO envelope
 * byte-identical for ordinary sends.
 */
import { describe, it, expect } from 'vitest'
import { pickBatchUuid } from '../../src/providers/batch-uuid.js'

const A = 'aaaaaaaa-1111-4111-8111-111111111111'
const B = 'bbbbbbbb-2222-4222-9222-222222222222'
const C = 'cccccccc-3333-4333-a333-333333333333'

describe('pickBatchUuid', () => {
  it('returns undefined for an empty batch', () => {
    expect(pickBatchUuid([])).toBeUndefined()
  })

  it('returns undefined when no row carries a uuid', () => {
    expect(pickBatchUuid([{}, {}, { userUuid: undefined }])).toBeUndefined()
  })

  it('returns the only uuid in the batch', () => {
    expect(pickBatchUuid([{}, { userUuid: A }, {}])).toBe(A)
  })

  it('returns the LAST uuid when several rows carry one', () => {
    expect(pickBatchUuid([{ userUuid: A }, { userUuid: B }, { userUuid: C }])).toBe(C)
  })

  it('skips uuid-less trailing rows to find the newest uuid', () => {
    expect(pickBatchUuid([{ userUuid: A }, { userUuid: B }, {}, {}])).toBe(B)
  })

  it('treats an empty-string uuid as absent', () => {
    expect(pickBatchUuid([{ userUuid: A }, { userUuid: '' }])).toBe(A)
  })

  it('does not mutate or reorder the input', () => {
    const rows = [{ userUuid: A }, { userUuid: B }]
    pickBatchUuid(rows)
    expect(rows).toEqual([{ userUuid: A }, { userUuid: B }])
  })
})
