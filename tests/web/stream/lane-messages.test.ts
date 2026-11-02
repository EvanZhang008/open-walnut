/**
 * A running subagent's lane is drawn as the transcript its agent will save
 * (`laneMessagesFromStream`, web/src/components/sessions/LaneTimeline.tsx), so
 * the saved transcript takes over the rows the stream drew when the agent
 * finishes (2026-11-01, the user: streaming and finished must look exactly the
 * same, "no flash"). Pins: one message per model message, calls with the words
 * before them, nothing for blocks that draw nothing, a nested agent's lane under
 * its call, the same row key as the saved message, and an unchanged message
 * kept as the same object while the lane streams (its row's memo holds).
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { parseHTML } from 'linkedom'
import type { StreamingBlock } from '@/stream/stream-reducer'

let lane: typeof import('../../../web/src/components/sessions/LaneTimeline')

beforeAll(async () => {
  const dom = parseHTML('<!DOCTYPE html><html><head></head><body></body></html>')
  Object.assign(globalThis, { window: dom.window, document: dom.document })
  lane = await import('../../../web/src/components/sessions/LaneTimeline')
})

const ROOT = 'toolu_root'
const tool = (id: string, status: 'calling' | 'done' | 'error', parent = ROOT, extra: Record<string, unknown> = {}): StreamingBlock =>
  ({ type: 'tool_call', toolUseId: id, name: 'Bash', input: { command: `cmd ${id}` }, status, parentToolUseId: parent, ...(status !== 'calling' ? { result: `${id} out` } : {}), ...extra }) as StreamingBlock
const text = (content: string, msgId: string, parent = ROOT): StreamingBlock => ({ type: 'text', content, msgId, parentToolUseId: parent }) as StreamingBlock
const thinking = (content: string, msgId: string): StreamingBlock => ({ type: 'thinking', content, msgId, parentToolUseId: ROOT }) as StreamingBlock

describe('a live lane as its transcript', () => {
  it('one message per model message: reasoning, words, then the calls that followed them', () => {
    const msgs = lane.laneMessagesFromStream(ROOT, [
      thinking('Look first.', 'm1'), text('Checking.', 'm1'), tool('a', 'done'), tool('b', 'calling'),
      text('Found it.', 'm2'),
    ])
    expect(msgs.map((m) => ({ msgId: m.msgId, text: m.text, thinking: m.thinking, tools: m.tools?.map((t) => [t.toolUseId, t.liveStatus]) }))).toEqual([
      { msgId: 'm1', text: 'Checking.', thinking: 'Look first.', tools: [['a', 'done'], ['b', 'calling']] },
      { msgId: 'm2', text: 'Found it.', thinking: undefined, tools: undefined },
    ])
  })

  it('calls before any words are a message of their own, named by its first call', () => {
    const msgs = lane.laneMessagesFromStream(ROOT, [tool('a', 'done'), tool('b', 'done'), text('Done.', 'm9')])
    expect(msgs[0].msgId).toBeUndefined()
    expect(lane.laneMessageKey(msgs[0])).toBe('a')
    // The saved twin of a message of calls alone has a msgId: the key is still its first call.
    expect(lane.laneMessageKey({ role: 'assistant', text: '', msgId: 'saved-1', timestamp: 't', tools: [{ name: 'Bash', input: {}, toolUseId: 'a' }] })).toBe('a')
    // A message with words is named by its msgId on both sides.
    expect(lane.laneMessageKey(msgs[1])).toBe('m9')
    expect(lane.laneMessageKey({ role: 'assistant', text: 'Done.', msgId: 'm9', timestamp: 't', tools: [{ name: 'Bash', input: {}, toolUseId: 'z' }] })).toBe('m9')
    // Its time does not move from one build to the next.
    const again = lane.laneMessagesFromStream(ROOT, [tool('a', 'done'), tool('b', 'done'), text('Done.', 'm9'), tool('c', 'calling')])
    expect(again[0].timestamp).toBe(msgs[0].timestamp)
  })

  it('blocks that draw nothing (an empty tail, a placeholder call) are not in it', () => {
    const msgs = lane.laneMessagesFromStream(ROOT, [
      tool('a', 'done'),
      { type: 'tool_call', toolUseId: 'ghost', name: 'Bash', input: {}, status: 'calling', parentToolUseId: ROOT } as StreamingBlock,
      text('  ', 'm2'),
      thinking('', 'm3'),
    ])
    expect(msgs).toHaveLength(1)
    expect(msgs[0].tools?.map((t) => t.toolUseId)).toEqual(['a'])
  })

  it("a nested agent's lane is under its call, as the saved transcript nests it", () => {
    const msgs = lane.laneMessagesFromStream(ROOT, [
      text('Spawning.', 'm1'),
      tool('agent2', 'calling', ROOT, { name: 'Agent', input: { description: 'inner', subagent_type: 'explore' } }),
      tool('inner-a', 'done', 'agent2'),
      text('Inner words.', 'inner-m', 'agent2'),
    ])
    expect(msgs).toHaveLength(1)
    const agent = msgs[0].tools![0]
    expect(agent.name).toBe('Agent')
    expect(agent.childMessages?.map((m) => m.text)).toEqual(['', 'Inner words.'])
    expect(agent.childMessages?.[0].tools?.[0].toolUseId).toBe('inner-a')
  })

  it('a message none of whose blocks changed is the same object, and one that grew is a new one', () => {
    const a = tool('a', 'done')
    const m1 = text('Checking.', 'm1')
    const first = lane.laneMessagesFromStream(ROOT, [m1, a, text('Fou', 'm2')])
    const second = lane.laneMessagesFromStream(ROOT, [m1, a, text('Found it.', 'm2')])
    expect(second[0]).toBe(first[0])
    expect(second[1]).not.toBe(first[1])
    expect(second[1].text).toBe('Found it.')
    // A nested lane that grew makes its parent message new too.
    const agentCall = tool('agent2', 'calling', ROOT, { name: 'Agent', input: { description: 'inner' } })
    const inner = tool('inner-a', 'done', 'agent2')
    const n1 = lane.laneMessagesFromStream(ROOT, [m1, agentCall, inner])
    const n2 = lane.laneMessagesFromStream(ROOT, [m1, agentCall, inner, tool('inner-b', 'calling', 'agent2')])
    expect(n2[0]).not.toBe(n1[0])
    expect(n2[0].tools![0].childMessages![0].tools).toHaveLength(2)
  })

  it('reads as the saved transcript does: the calls fold into one run', () => {
    const parts = lane.laneHistoryParts(lane.laneMessagesFromStream(ROOT, [tool('a', 'done'), tool('b', 'calling'), text('Found it.', 'm2')]))
    expect(parts.map((p) => p.kind)).toEqual(['run', 'msg'])
  })
})
