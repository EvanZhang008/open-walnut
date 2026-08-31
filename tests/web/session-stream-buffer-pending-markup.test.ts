/**
 * The server-side twin of the interrupt carry (inc-1788209680147).
 *
 * A card interrupting the model's text must not leave half a tag behind. The
 * browser reducer already carries the fragment forward, but the buffer is what a
 * RELOAD renders from — so a rule only the client applied would look fixed until
 * the page was refreshed mid-turn, and then the empty pill plus the leaked
 * attribute text would be back.
 *
 * The reported shape, exactly: text ends one character into an attribute
 * (`padding:8`), a `commands_changed` system card lands, and the model resumes
 * with `px">…`.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { sessionStreamBuffer } from '../../src/web/session-stream-buffer.js'

const SID = 'pending-markup-test-session'
const HEAD = 'Skill 更新完，现在按新标准重排：\n\n'
const OPEN = '<div style="border-left:3px solid #dc2626;padding:8'

function texts() {
  return sessionStreamBuffer.getSnapshot(SID).blocks
    .filter(b => b.type === 'text')
    .map(b => (b as { content: string }).content)
}

describe('sessionStreamBuffer: a card never cuts a tag in half', () => {
  beforeEach(() => {
    sessionStreamBuffer.clear(SID)
  })

  it('a system card carries the unfinished tag into the resumed block', () => {
    sessionStreamBuffer.appendTextDelta(SID, HEAD + OPEN, 'msg_A')
    sessionStreamBuffer.appendSystem(SID, 'info', 'commands_changed', '{"commands":[]}')
    sessionStreamBuffer.appendTextDelta(SID, 'px">全部降级为基线</div>', 'msg_A')

    const snap = sessionStreamBuffer.getSnapshot(SID)
    expect(snap.blocks.map(b => b.type)).toEqual(['text', 'system', 'text'])
    const [above, below] = texts()
    expect(above).toBe(HEAD)                      // nothing half-written above the card
    expect(below).toBe(OPEN + 'px">全部降级为基线</div>')  // one whole tag below it
    expect(below.startsWith('px">')).toBe(false)  // the leaked attribute is gone
    expect(above + below).toBe(HEAD + OPEN + 'px">全部降级为基线</div>') // lossless
  })

  it('a tool card does the same', () => {
    sessionStreamBuffer.appendTextDelta(SID, 'Let me look. <span class="hl', 'msg_A')
    sessionStreamBuffer.appendToolUse(SID, 'tu-1', 'Read', { file_path: '/x' })
    sessionStreamBuffer.appendTextDelta(SID, '">found it</span>', 'msg_A')

    expect(texts()).toEqual(['Let me look. ', '<span class="hl">found it</span>'])
  })

  it('a permission card does the same', () => {
    sessionStreamBuffer.appendTextDelta(SID, 'Running now. <code style="color:red', 'msg_A')
    sessionStreamBuffer.appendPermission(SID, 'req-1', 'Bash', { command: 'ls' })
    sessionStreamBuffer.appendTextDelta(SID, '">ls</code>', 'msg_A')

    expect(texts()).toEqual(['Running now. ', '<code style="color:red">ls</code>'])
  })

  it('drops a block that held NOTHING but the fragment', () => {
    sessionStreamBuffer.appendTextDelta(SID, '<div style="padding:8', 'msg_A')
    sessionStreamBuffer.appendSystem(SID, 'info', 'compacted')
    // No empty text row above the card.
    expect(sessionStreamBuffer.getSnapshot(SID).blocks.map(b => b.type)).toEqual(['system'])

    sessionStreamBuffer.appendTextDelta(SID, 'px">x</div>', 'msg_A')
    expect(texts()).toEqual(['<div style="padding:8px">x</div>'])
  })

  it('ordinary text is untouched — no carry, no reshaping', () => {
    sessionStreamBuffer.appendTextDelta(SID, 'Let me check the file.', 'msg_A')
    sessionStreamBuffer.appendToolUse(SID, 'tu-1', 'Read', {})
    sessionStreamBuffer.appendTextDelta(SID, 'Found the bug.', 'msg_A')

    expect(texts()).toEqual(['Let me check the file.', 'Found the bug.'])
  })

  it('turn over: the held fragment is RENDERED, not swallowed', () => {
    // Nothing is coming to finish it, so hiding it would silently delete text the
    // model wrote. Persisted history shows the same characters.
    sessionStreamBuffer.appendTextDelta(SID, 'Almost done. <div style="padding:8', 'msg_A')
    sessionStreamBuffer.appendSystem(SID, 'info', 'commands_changed')
    sessionStreamBuffer.markDone(SID)

    expect(texts().join('')).toBe('Almost done. <div style="padding:8')
  })

  it('a fragment held at turn end never opens the NEXT turn', () => {
    sessionStreamBuffer.appendTextDelta(SID, 'One. <b class="x', 'msg_A')
    sessionStreamBuffer.appendSystem(SID, 'info', 'commands_changed')
    sessionStreamBuffer.markDone(SID)
    // New turn: its first block starts clean, with no inherited `<b class="x`.
    sessionStreamBuffer.appendTextDelta(SID, 'Two.', 'msg_B')

    expect(texts()).toEqual(['Two.'])
  })

  it('a fragment held across a card does not leak into the NEXT message', () => {
    // Defensive: the carry is consumed by the first block that follows, whichever
    // message it belongs to, and never applied twice.
    sessionStreamBuffer.appendTextDelta(SID, 'first <b class="x', 'msg_A')
    sessionStreamBuffer.appendSystem(SID, 'info', 'commands_changed')
    sessionStreamBuffer.appendTextDelta(SID, '">bold</b>', 'msg_B')
    sessionStreamBuffer.appendTextDelta(SID, ' more', 'msg_B')

    expect(texts()).toEqual(['first ', '<b class="x">bold</b> more'])
  })
})
