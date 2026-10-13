import { afterEach, describe, expect, it } from 'vitest'
import { AcpHistoryFold, AcpJournalProjector, projectAcpJournalHistory } from '../../src/providers/acp-journal-projector.js'
import { AcpStreamNormalizer } from '../../src/providers/acp-stream-normalizer.js'
import type { JournalRecord } from '../../src/providers/acp-worker/protocol.js'
import { collectRequestedRevisions, isUnsettledRow, resolveDeltaStart } from '../../src/core/history-delta.js'
import { sessionStreamBuffer } from '../../src/web/session-stream-buffer.js'
import { applyRevisedMessages, collectUnsettledIds } from '@/hooks/history-anchor'
import { appendMainThinking, appendSystemBlock, applyMainTextDelta, lastMainLaneText, type StreamingBlock } from '@/stream/stream-reducer'
import { buildIdOnlyEvidence, promoteCompletedBlocks } from '@/cache/promote-blocks'
import { allBlocksAbsorbed, computeRenderFilter } from '@/stream/render-filter'

const SID = 'retry-display-test'
const RUNTIME = 'retry-runtime'
const HEADLINE = 'Response interrupted. Codex is retrying.'
const update = (ts: number, value: Record<string, unknown>, source: 'live' | 'control' | 'provider-replay' = 'live'): JournalRecord => ({
  kind: 'acp', ts, source, frame: { method: 'session/update', params: { sessionId: 'provider-test', update: value } },
})
const chunk = (ts: number, text: string, messageId = 'message-a', thought = false): JournalRecord => update(ts, {
  sessionUpdate: thought ? 'agent_thought_chunk' : 'agent_message_chunk', messageId, content: { type: 'text', text },
})
const retry = (ts: number, source: 'live' | 'control' | 'provider-replay' = 'live'): JournalRecord => update(ts, {
  sessionUpdate: 'session_info_update',
  _meta: { codex: { error: {
    willRetry: true,
    codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } },
    turnId: 'provider-turn',
    additionalDetails: 'stream disconnected before completion: idle timeout waiting for SSE',
  } } },
}, source)
const ended: JournalRecord = { kind: 'meta', ts: 100, event: { type: 'turn-ended', commandId: 'legacy', stopReason: 'end_turn' } }

afterEach(() => sessionStreamBuffer.clear(SID))

describe('ACP explicit response retry display', () => {
  it.each(['message-b', 'message-a'])('preserves the failed response and allocates a new segment for %s', (nextId) => {
    const partial = '\u4e00\u6bb5 partial\n<div style="' + ' detail '.repeat(512)
    const records = [chunk(1, 'reasoning', 'message-a', true), chunk(2, partial), retry(3), chunk(4, 'final answer', nextId), ended]
    const history = projectAcpJournalHistory(RUNTIME, records)
    expect(history).toHaveLength(2)
    expect(history[0]).toMatchObject({ role: 'system', text: HEADLINE, systemVariant: 'error', systemDetail: `${partial}\n\nreasoning`, msgId: `acp:${RUNTIME}:legacy:segment:0` })
    expect(history[0].thinking).toBeUndefined()
    expect(history[0].unsettled).toBeUndefined()
    expect(history[1]).toMatchObject({ role: 'assistant', text: 'final answer', msgId: `acp:${RUNTIME}:legacy:segment:1` })
    expect(history[1].unsettled).toBeUndefined()

    const normalizer = new AcpStreamNormalizer(new AcpJournalProjector(RUNTIME))
    const events = records.flatMap(record => normalizer.normalize(record))
    const notice = events.find(event => event.name === 'session:system-event')!
    expect(notice.payload).toMatchObject({ uuid: history[0].msgId, replacesMsgId: history[0].msgId, detail: history[0].systemDetail })
    expect(events.filter(event => event.name === 'session:error')).toEqual([])
    expect(events.filter(event => event.name === 'session:result')).toHaveLength(1)
  })

  it('keeps repeated attempts separately and gives a retry without new text its own notice', () => {
    const records = [chunk(1, 'first'), retry(2), retry(3), chunk(4, 'second'), retry(5), chunk(6, 'final'), ended]
    const history = projectAcpJournalHistory(RUNTIME, records)
    expect(history.map(row => [row.role, row.text, row.systemDetail])).toEqual([
      ['system', HEADLINE, 'first'], ['system', HEADLINE, undefined], ['system', HEADLINE, 'second'], ['assistant', 'final', undefined],
    ])
    expect(new Set(history.map(row => row.msgId)).size).toBe(4)
  })

  it('does not replace completed commentary or tools when no current response text exists', () => {
    const records = [
      chunk(1, 'commentary'),
      update(2, { sessionUpdate: 'tool_call', toolCallId: 'call-a', title: 'Read' }),
      update(3, { sessionUpdate: 'tool_call_update', toolCallId: 'call-a', status: 'completed', rawOutput: 'tool result' }),
      retry(4), chunk(5, 'final'), ended,
    ]
    const history = projectAcpJournalHistory(RUNTIME, records)
    expect(history.map(row => row.role)).toEqual(['assistant', 'assistant', 'system', 'assistant'])
    expect(history[0].text).toBe('commentary')
    expect(history[1].tools?.[0].result).toBe('tool result')
    expect(history[2].systemDetail).toBeUndefined()
    const normalizer = new AcpStreamNormalizer(new AcpJournalProjector(RUNTIME))
    expect(records.flatMap(record => normalizer.normalize(record)).find(event => event.name === 'session:system-event')?.payload.replacesMsgId).toBeUndefined()
    expect(projectAcpJournalHistory(RUNTIME, [retry(1), chunk(2, 'answer'), ended]).map(row => row.role)).toEqual(['system', 'assistant'])
  })

  it('does not replace a prior text segment when the last content was a different thought segment', () => {
    const history = projectAcpJournalHistory(RUNTIME, [chunk(1, 'commentary'), chunk(2, 'new thought', 'message-b', true), retry(3), ended])
    expect(history[0]).toMatchObject({ role: 'assistant', text: 'commentary' })
    expect(history[1]).toMatchObject({ role: 'assistant', thinking: 'new thought' })
    expect(history[2]).toMatchObject({ role: 'system', text: HEADLINE })
    expect(history[2].systemDetail).toBeUndefined()
  })

  it.each(['control', 'provider-replay'] as const)('ignores %s retry frames without breaking the current segment', (source) => {
    const records = [chunk(1, 'first '), retry(2, source), chunk(3, 'continued'), ended]
    expect(projectAcpJournalHistory(RUNTIME, records).map(row => row.text)).toEqual(['first continued'])
  })

  it.each([
    { willRetry: false, codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } } },
    { willRetry: true, codexErrorInfo: { otherError: {} } },
    { willRetry: true, additionalDetails: 'stream disconnected before completion: idle timeout waiting for SSE' },
  ])('ignores unrelated info updates regardless of error prose: %j', (error) => {
    const records = [chunk(1, 'first '), update(2, { sessionUpdate: 'session_info_update', _meta: { codex: { error } } }), chunk(3, 'continued'), ended]
    expect(projectAcpJournalHistory(RUNTIME, records).map(row => row.text)).toEqual(['first continued'])
  })

  it('revises a previously synced active segment in place at an unchanged cursor', () => {
    const fold = new AcpHistoryFold(RUNTIME)
    fold.push(chunk(1, 'partial'))
    const held = fold.messages.map(row => ({ ...row }))
    expect(isUnsettledRow(held[0])).toBe(true)
    const requestedIds = collectUnsettledIds(held)
    fold.push(retry(2))
    expect(resolveDeltaStart(fold.messages, { since: 1, anchorMsgId: held[0].msgId })).toEqual({ kind: 'delta', start: 1 })
    const { revised, ambiguous } = collectRequestedRevisions(fold.messages, requestedIds)
    expect(ambiguous).toBe(false)
    const merged = applyRevisedMessages(held, revised)
    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({ role: 'system', systemDetail: 'partial', text: HEADLINE, msgId: held[0].msgId })
    expect(collectUnsettledIds(merged)).toEqual([])
  })

  it('does not restore an interrupted response into a resumed text accumulator', () => {
    const blocks: StreamingBlock[] = [
      { type: 'text', content: 'partial', msgId: 'old' },
      { type: 'system', variant: 'error', message: HEADLINE, detail: 'partial', uuid: 'old', replacesMsgId: 'old' },
    ]
    expect(lastMainLaneText(blocks)).toBeUndefined()
    const next = applyMainTextDelta(blocks, '', 'final', 'new', 0)
    expect(next.blocks[2]).toMatchObject({ type: 'text', content: 'final', msgId: 'new' })
    expect(lastMainLaneText(next.blocks)?.msgId).toBe('new')
  })

  it('collects an archived retry notice and its exact raw copies together', () => {
    const blocks: StreamingBlock[] = [
      { type: 'thinking', content: 'reasoning', msgId: 'old' },
      { type: 'text', content: 'partial', msgId: 'old' },
      { type: 'system', variant: 'error', message: HEADLINE, detail: 'partial\n\nreasoning', uuid: 'old', replacesMsgId: 'old' },
      { type: 'text', content: 'final', msgId: 'new' },
    ]
    const rows = [{ role: 'system' as const, text: HEADLINE, msgId: 'old', timestamp: '', systemVariant: 'error' as const, systemDetail: 'partial\n\nreasoning' }]
    expect(promoteCompletedBlocks(blocks, [], blocks.length).kept).toBe(blocks)
    const collected = promoteCompletedBlocks(blocks, rows, blocks.length, buildIdOnlyEvidence(rows))
    expect(collected.kept).toEqual([blocks[3]])
    expect(collected.removed).toBe(3)
    expect(collected.unmatched.map(row => row.index)).toEqual([3])
  })

  it.each(['message-b', 'message-a'])('keeps live, snapshot and history evidence aligned for %s', (nextId) => {
    const records = [chunk(1, 'thought', 'message-a', true), chunk(2, 'partial <div style="'), retry(3), chunk(4, 'final', nextId)]
    const normalizer = new AcpStreamNormalizer(new AcpJournalProjector(RUNTIME))
    let blocks: StreamingBlock[] = []
    let textBuffer = ''
    sessionStreamBuffer.markStreaming(SID)
    for (const event of records.flatMap(record => normalizer.normalize(record))) {
      const { delta, msgId, variant, message, detail, uuid, replacesMsgId } = event.payload as {
        delta: string; msgId: string; variant: 'error'; message: string; detail: string; uuid: string; replacesMsgId: string;
      }
      if (event.name === 'session:text-delta') {
        const next = applyMainTextDelta(blocks, textBuffer, delta, msgId, 0)
        blocks = next.blocks
        textBuffer = next.textBuffer
        sessionStreamBuffer.appendTextDelta(SID, delta, msgId)
      } else if (event.name === 'session:thinking-delta') {
        blocks = appendMainThinking(blocks, delta, msgId, 0)
        sessionStreamBuffer.appendThinkingDelta(SID, delta, msgId)
      } else if (event.name === 'session:system-event') {
        textBuffer = ''
        blocks = appendSystemBlock(blocks, { variant, message, detail, uuid, replacesMsgId })
        sessionStreamBuffer.appendSystem(SID, variant, message, detail, undefined, uuid, replacesMsgId)
      }
    }
    expect(blocks).toEqual(sessionStreamBuffer.getSnapshot(SID).blocks)
    expect(blocks.map(block => block.type)).toEqual(['thinking', 'text', 'system', 'text'])
    const live = computeRenderFilter({ blocks, messages: [], watermark: 0, isStreaming: true })
    expect([...live.hidden]).toEqual([0, 1])
    expect(live.unmatched).toEqual([])
    expect(blocks[1]).toMatchObject({ content: 'partial <div style="' })
    const messages = projectAcpJournalHistory(RUNTIME, [...records, ended])
    const after = computeRenderFilter({ blocks, messages, watermark: 0, isStreaming: false })
    expect(allBlocksAbsorbed(blocks, after.hidden, false)).toBe(true)
    expect(after.unmatched).toEqual([])
  })
})
