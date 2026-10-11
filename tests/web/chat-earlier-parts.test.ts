/**
 * ChatEarlierBlock's folding (web/src/components/sessions/ChatEarlierBlock.tsx):
 * the earlier part of a chat arrives in the phone's row shape, text rows and
 * tool/thinking rows interleaved; the block shows the text and folds each run
 * of steps between them into one muted line.
 */
import { describe, expect, it } from 'vitest'
import { earlierParts, type ChatEarlierMessage } from '../../web/src/components/sessions/chat-earlier-parts'

const row = (id: string, role: 'user' | 'assistant', text: string, kind?: ChatEarlierMessage['kind']): ChatEarlierMessage =>
  ({ id, role, text, ...(kind ? { kind } : {}) })

describe('earlierParts', () => {
  it('keeps text rows in order and folds each run of steps into one count', () => {
    const parts = earlierParts([
      row('m0', 'user', 'Find the invoice'),
      row('m1', 'assistant', 'Thinking about it', 'thinking'),
      row('m2', 'assistant', 'Bash', 'tool'),
      row('m3', 'assistant', 'Read', 'tool'),
      row('m4', 'assistant', 'Found it in the mail.'),
      row('m5', 'assistant', 'Grep', 'tool'),
      row('m6', 'user', 'Thanks'),
    ])
    expect(parts).toEqual([
      { kind: 'text', row: row('m0', 'user', 'Find the invoice') },
      { kind: 'steps', key: 'm1', count: 3 },
      { kind: 'text', row: row('m4', 'assistant', 'Found it in the mail.') },
      { kind: 'steps', key: 'm5', count: 1 },
      { kind: 'text', row: row('m6', 'user', 'Thanks') },
    ])
  })

  it('drops blank text rows and keeps notification rows as text parts', () => {
    const parts = earlierParts([
      row('m0', 'assistant', '   '),
      row('m1', 'user', 'Turn interrupted', 'notification'),
      row('m2', 'user', 'Again, please'),
    ])
    expect(parts.map((p) => p.kind === 'text' ? p.row.id : p.key)).toEqual(['m1', 'm2'])
  })

  it('answers nothing for nothing', () => {
    expect(earlierParts([])).toEqual([])
  })
})
