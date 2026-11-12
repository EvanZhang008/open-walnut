/**
 * The Ask here hint rides every message of a question's thread, so it stays one short line
 * (2026-11-12, the user, of a ~900-character block on each message: "what is this ask here...
 * hmm"). The line is self-contained: nothing of it moves into the prompt every request carries.
 */
import { describe, expect, it } from 'vitest'
import { askHintText, askNameOf } from '../../../src/core/sessions/ask-thread'
import { renderHintBlock } from '../../../src/core/hints/hint-format'
import { defaultInstructions } from '../../../src/core/sessions/session-context'

/** The most a question's line may cost on one message, with the longest name a question gets. */
const MAX_HINT_BYTES = 440

describe('Ask here hint size', () => {
  it('one short line, even for the longest name and a nested thread', () => {
    const name = askNameOf(undefined, 'x'.repeat(200))
    expect(name.length).toBe(60)
    const block = renderHintBlock('question', askHintText('12.3.4', name), '12.3.4')
    expect(Buffer.byteLength(block, 'utf8')).toBeLessThanOrEqual(MAX_HINT_BYTES)
    expect(askHintText('6', 'n').split('\n')).toHaveLength(1)
  })

  it('still names the question and the answer tag the readers look for', () => {
    const text = askHintText('6.1', 'guestbook deployer')
    expect(text).toContain('<walnut-ask thread="6.1" name="guestbook deployer">')
    expect(text).toMatch(/walnut-ask-answer/)
  })

  it('says where the answer goes on its own: the opening line, the closing tag, every later part', () => {
    const text = askHintText('6', 'n')
    expect(text).toContain('begin your reply with the line <walnut-ask-answer thread="6" name="n">')
    expect(text).toContain('</walnut-ask-answer>')
    expect(text).toMatch(/every later part/)
  })

  it('adds nothing to the prompt of any kind of session', () => {
    for (const task of [{}, { org_role: 'lead' }, { org_role: 'main' }, { walnut_agent: true }] as Parameters<typeof defaultInstructions>[0][]) {
      expect(defaultInstructions(task)).not.toContain('walnut-ask-answer')
    }
  })
})
