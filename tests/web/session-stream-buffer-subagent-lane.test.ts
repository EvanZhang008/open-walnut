/**
 * Inline-subagent lane isolation (the "output completely broken" bug,
 * inc-1783547185298).
 *
 * The CLI interleaves a subagent's whole conversation (assistant text +
 * tool_use lines, parent_tool_use_id set) into the MIDDLE of the main turn's
 * token stream. Before lane isolation, each subagent line cut the main text
 * accumulator, splitting the main reply mid-token ("**$0.10/c" | "luster…")
 * and injecting subagent English into the middle of the main answer.
 *
 * Rules pinned here:
 *   1. subagent text NEVER merges into main-lane text (and vice versa)
 *   2. a subagent tool_use does NOT reset the main text accumulator
 *   3. main deltas arriving AFTER an interleaved subagent line continue the
 *      SAME main block (anchor = last main-lane block, not blocks[len-1])
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { sessionStreamBuffer } from '../../src/web/session-stream-buffer.js'

const SID = 'subagent-lane-test-session'
const PARENT = 'toolu_parent_agent_1'

describe('sessionStreamBuffer subagent lane isolation', () => {
  beforeEach(() => {
    sessionStreamBuffer.clear(SID)
  })

  it('keeps main text in ONE block when a subagent text line interleaves mid-stream', () => {
    sessionStreamBuffer.appendTextDelta(SID, '机架(3× i', 'msg_main')
    sessionStreamBuffer.appendTextDelta(SID, '3en.24xl', 'msg_main')
    // interleaved inline-subagent assistant line
    sessionStreamBuffer.appendTextDelta(SID, 'Now I have the two distinct enums.', 'msg_sub', PARENT)
    // main turn continues
    sessionStreamBuffer.appendTextDelta(SID, '):**\n- All Upfront', 'msg_main')

    const snap = sessionStreamBuffer.getSnapshot(SID)
    const mainTexts = snap.blocks.filter((b) => b.type === 'text' && !b.parentToolUseId)
    const subTexts = snap.blocks.filter((b) => b.type === 'text' && b.parentToolUseId === PARENT)
    expect(mainTexts).toHaveLength(1)
    expect(mainTexts[0]).toMatchObject({ content: '机架(3× i3en.24xl):**\n- All Upfront', msgId: 'msg_main' })
    expect(subTexts).toHaveLength(1)
    expect(subTexts[0]).toMatchObject({ content: 'Now I have the two distinct enums.', msgId: 'msg_sub' })
  })

  it('subagent tool_use does not cut the main text accumulator', () => {
    sessionStreamBuffer.appendTextDelta(SID, '**$0.10/c', 'msg_main')
    sessionStreamBuffer.appendToolUse(SID, 'toolu_sub_1', 'Bash', { command: 'grep' }, undefined, PARENT)
    sessionStreamBuffer.appendTextDelta(SID, 'luster/小时** ≈ $73/月', 'msg_main')

    const snap = sessionStreamBuffer.getSnapshot(SID)
    const mainTexts = snap.blocks.filter((b) => b.type === 'text' && !b.parentToolUseId)
    expect(mainTexts).toHaveLength(1)
    expect(mainTexts[0]).toMatchObject({ content: '**$0.10/cluster/小时** ≈ $73/月' })
  })

  it('MAIN tool_use still cuts main text flow (unchanged behavior)', () => {
    sessionStreamBuffer.appendTextDelta(SID, 'before', 'msg_main')
    sessionStreamBuffer.appendToolUse(SID, 'toolu_main_1', 'Bash', { command: 'ls' })
    sessionStreamBuffer.appendTextDelta(SID, 'after', 'msg_main')

    const snap = sessionStreamBuffer.getSnapshot(SID)
    expect(snap.blocks.map((b) => b.type)).toEqual(['text', 'tool_call', 'text'])
  })

  it('two different subagent lanes accumulate independently', () => {
    const P2 = 'toolu_parent_agent_2'
    sessionStreamBuffer.appendTextDelta(SID, 'lane1-a', 'msg_s1', PARENT)
    sessionStreamBuffer.appendTextDelta(SID, 'lane2-a', 'msg_s2', P2)
    sessionStreamBuffer.appendTextDelta(SID, ' lane1-b', 'msg_s1', PARENT)

    const snap = sessionStreamBuffer.getSnapshot(SID)
    const lane1 = snap.blocks.filter((b) => b.type === 'text' && b.parentToolUseId === PARENT)
    const lane2 = snap.blocks.filter((b) => b.type === 'text' && b.parentToolUseId === P2)
    expect(lane1).toHaveLength(1)
    expect(lane1[0]).toMatchObject({ content: 'lane1-a lane1-b' })
    expect(lane2).toHaveLength(1)
    expect(lane2[0]).toMatchObject({ content: 'lane2-a' })
  })

  it('subagent thinking is isolated from main thinking', () => {
    sessionStreamBuffer.appendThinkingDelta(SID, 'main thought', 'msg_main')
    sessionStreamBuffer.appendThinkingDelta(SID, 'sub thought', 'msg_sub', PARENT)
    sessionStreamBuffer.appendThinkingDelta(SID, ' continues', 'msg_main')

    const snap = sessionStreamBuffer.getSnapshot(SID)
    const main = snap.blocks.filter((b) => b.type === 'thinking' && !b.parentToolUseId)
    const sub = snap.blocks.filter((b) => b.type === 'thinking' && b.parentToolUseId === PARENT)
    expect(main).toHaveLength(1)
    expect(main[0]).toMatchObject({ content: 'main thought continues' })
    expect(sub).toHaveLength(1)
    expect(sub[0]).toMatchObject({ content: 'sub thought' })
  })

  it('subagent lane starts a new block on msgId change (two subagent messages)', () => {
    sessionStreamBuffer.appendTextDelta(SID, 'first sub msg', 'msg_s1', PARENT)
    sessionStreamBuffer.appendTextDelta(SID, 'second sub msg', 'msg_s2', PARENT)
    const snap = sessionStreamBuffer.getSnapshot(SID)
    const sub = snap.blocks.filter((b) => b.type === 'text' && b.parentToolUseId === PARENT)
    expect(sub).toHaveLength(2)
  })

  it('stamps subagentType/taskDescription on new subagent text and tool_call blocks', () => {
    sessionStreamBuffer.appendTextDelta(SID, 'hello from sub', 'msg_s1', PARENT, 'Explore', 'Scan the repo')
    sessionStreamBuffer.appendToolUse(SID, 'toolu_sub_2', 'Bash', { command: 'ls' }, undefined, PARENT, 'Explore', 'Scan the repo')
    const snap = sessionStreamBuffer.getSnapshot(SID)
    const subText = snap.blocks.find((b) => b.type === 'text' && b.parentToolUseId === PARENT)
    const subTool = snap.blocks.find((b) => b.type === 'tool_call' && b.parentToolUseId === PARENT)
    expect(subText).toMatchObject({ subagentType: 'Explore', taskDescription: 'Scan the repo' })
    expect(subTool).toMatchObject({ subagentType: 'Explore', taskDescription: 'Scan the repo' })
  })
})

describe('sessionStreamBuffer late background-subagent lines (post-result)', () => {
  beforeEach(() => {
    sessionStreamBuffer.clear(SID)
  })

  it('a late subagent text line does NOT wipe the finished turn blocks', () => {
    // Main turn: text + parent Agent tool_call, then the turn ends
    sessionStreamBuffer.appendTextDelta(SID, 'main answer', 'msg_main')
    sessionStreamBuffer.appendToolUse(SID, PARENT, 'Agent', { description: 'bg research', subagent_type: 'Explore' })
    sessionStreamBuffer.markDone(SID)

    // Background subagent keeps producing after the result
    sessionStreamBuffer.appendTextDelta(SID, 'late sub line', 'msg_sub', PARENT, 'Explore', 'bg research')

    const snap = sessionStreamBuffer.getSnapshot(SID)
    // Finished-turn blocks retained — parent Agent tool_call still present
    expect(snap.blocks.some((b) => b.type === 'tool_call' && b.toolUseId === PARENT)).toBe(true)
    expect(snap.blocks.some((b) => b.type === 'text' && !b.parentToolUseId && b.content === 'main answer')).toBe(true)
    // The late line landed in its lane
    expect(snap.blocks.some((b) => b.type === 'text' && b.parentToolUseId === PARENT)).toBe(true)
  })

  it('a late subagent tool_use does NOT wipe the finished turn blocks', () => {
    sessionStreamBuffer.appendTextDelta(SID, 'main answer', 'msg_main')
    sessionStreamBuffer.appendToolUse(SID, PARENT, 'Agent', { description: 'bg research' })
    sessionStreamBuffer.markDone(SID)

    sessionStreamBuffer.appendToolUse(SID, 'toolu_sub_late', 'Read', { file_path: '/x' }, undefined, PARENT)

    const snap = sessionStreamBuffer.getSnapshot(SID)
    expect(snap.blocks.some((b) => b.type === 'tool_call' && b.toolUseId === PARENT)).toBe(true)
    expect(snap.blocks.some((b) => b.type === 'tool_call' && b.toolUseId === 'toolu_sub_late')).toBe(true)
  })

  it('a late subagent thinking line does NOT wipe the finished turn blocks', () => {
    sessionStreamBuffer.appendTextDelta(SID, 'main answer', 'msg_main')
    sessionStreamBuffer.markDone(SID)

    sessionStreamBuffer.appendThinkingDelta(SID, 'late sub thought', 'msg_sub', PARENT)

    const snap = sessionStreamBuffer.getSnapshot(SID)
    expect(snap.blocks.some((b) => b.type === 'text' && !b.parentToolUseId && b.content === 'main answer')).toBe(true)
    expect(snap.blocks.some((b) => b.type === 'thinking' && b.parentToolUseId === PARENT)).toBe(true)
  })

  it('the NEXT main-lane data still starts a fresh turn (drops finished blocks)', () => {
    sessionStreamBuffer.appendTextDelta(SID, 'old turn', 'msg_old')
    sessionStreamBuffer.markDone(SID)
    // Late subagent line between the turns must not break new-turn semantics
    sessionStreamBuffer.appendTextDelta(SID, 'late sub', 'msg_sub', PARENT)
    sessionStreamBuffer.appendTextDelta(SID, 'new turn', 'msg_new')

    const snap = sessionStreamBuffer.getSnapshot(SID)
    const mainTexts = snap.blocks.filter((b) => b.type === 'text' && !b.parentToolUseId)
    expect(mainTexts).toHaveLength(1)
    expect(mainTexts[0]).toMatchObject({ content: 'new turn' })
  })
})
