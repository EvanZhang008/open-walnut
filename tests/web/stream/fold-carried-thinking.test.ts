/**
 * Reasoning the client held back for its 150 ms flush, met by a snapshot it adopts
 * (web/src/hooks/useSessionStream.ts): the server takes the snapshot, may broadcast a delta
 * before it answers, and the client buffers that delta first. Already at the end of the
 * snapshot's open reasoning, it is there; otherwise it is appended. Never lost, never twice.
 */
import { describe, it, expect } from 'vitest'
import { foldCarriedThinking, type StreamingBlock } from '../../../web/src/stream/stream-reducer'

const think = (content: string, msgId = 'm1'): StreamingBlock => ({ type: 'thinking', content, msgId } as StreamingBlock)

describe('foldCarriedThinking', () => {
  it('nothing carried leaves the snapshot as it is', () => {
    const blocks = [think('a')]
    expect(foldCarriedThinking(blocks, null, 0)).toBe(blocks)
  })
  it('a chunk the snapshot already ends with is not added again', () => {
    const blocks = [think('weighing the options')]
    expect(foldCarriedThinking(blocks, { text: ' options', msgId: 'm1' }, 0)).toBe(blocks)
  })
  it('a chunk broadcast after the snapshot was taken is appended to its open reasoning', () => {
    const out = foldCarriedThinking([think('weighing the')], { text: ' options', msgId: 'm1' }, 0)
    expect(out).toEqual([think('weighing the options')])
  })
  it('a chunk of a newer message starts its own block', () => {
    const out = foldCarriedThinking([think('first')], { text: 'second', msgId: 'm2' }, 0)
    expect(out).toEqual([think('first'), think('second', 'm2')])
  })
  it('a finished turn in the snapshot is never extended', () => {
    const out = foldCarriedThinking([think('done')], { text: 'next', msgId: 'm1' }, 1)
    expect(out).toEqual([think('done'), think('next')])
  })
})
