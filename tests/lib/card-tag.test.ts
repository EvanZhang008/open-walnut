/**
 * The card line a session ends its reply with (src/lib/card-tag.ts; experiment threads_reply_tag,
 * 2026-11-25, the user: the chat reply is "both its reply to me and its reply to the thread"):
 * every form it may take, every reason a wrong one gives, where it counts, and that no reader of a
 * reply's text shows it, while the reply streams in too.
 */
import { describe, expect, it } from 'vitest'
import { CARD_ALIASES, CARD_MAX, CARD_TAG_FORM, CARD_TAIL_LINES, cardLinesOf, cardTagLine, hasCardLine, readCardTags, stripCardTags } from '../../src/lib/card-tag.js'
import { stripInternalLines, splitInternalLines } from '../../src/lib/internal-lines.js'
import { NO_ACTION_TAG, readTurnMarker, stripTurnMarker } from '../../src/lib/turn-end-marker.js'
import { hasWordsBeyondControl, withoutWalnutControl } from '../../src/lib/walnut-control-text.js'

const FENCE = 'th-1a2b3c4d5e6f'
const SEEDS = 'th-0f9e8d7c6b5a'
const WORDS = 'Two metres keeps the deer out.'

describe('the forms a card line takes', () => {
  it('writes the line a session is told to write', () => {
    expect(cardTagLine(FENCE)).toBe(`<walnut-card thread="${FENCE}" state="answered"/>`)
    expect(cardTagLine(FENCE, 'working')).toBe(`<walnut-card thread="${FENCE}" state="working"/>`)
    expect(CARD_TAG_FORM).toBe('<walnut-card thread="th-..." state="answered"/>')
  })

  it.each(['working', 'waiting', 'answered', 'done'] as const)('a state alone: %s', (state) => {
    const read = readCardTags(`${WORDS}\n\n${cardTagLine(FENCE, state)}`)
    expect(read).toEqual({ text: WORDS, cards: [{ thread: FENCE, state }], errors: [], unread: [], unnamed: [], tagged: true })
  })

  it('a title, a summary and a reaction ride the line; entities and spaces read as written', () => {
    const read = readCardTags(`${WORDS}\n<walnut-card thread="${FENCE}" state="answered" title="Orchard  fence" summary="Two metres: &quot;deer&quot; stay out, a -> b &amp; c" seen="yes" />`)
    expect(read.errors).toEqual([])
    expect(read.cards).toEqual([{ thread: FENCE, state: 'answered', title: 'Orchard fence', summary: 'Two metres: "deer" stay out, a -> b & c', seen: true }])
  })

  it('a decision carries what he decides, the choices in order, his kind and why', () => {
    const read = readCardTags(`Which wood?\n<walnut-card thread="${FENCE}" state="needs" ask="Which wood for the fence?" options="Larch; Oak\uff1b Pine ;" kind="spending" why="The oak costs twice the budget he set"/>`)
    expect(read.errors).toEqual([])
    expect(read.cards).toEqual([{ thread: FENCE, state: 'needs', ask: 'Which wood for the fence?', options: ['Larch', 'Oak', 'Pine'], kind: 'spending', why: 'The oak costs twice the budget he set' }])
  })

  // 2026-11-25, a live session marked its choice the status answer's way, and his button read
  // "Raised bed (recommended)" beside the card's own mark.
  it('a choice marked "(recommended)" is the recommended one: the mark leaves its label and it goes first', () => {
    const options = (text: string) => readCardTags(`Which wood?\n<walnut-card thread="${FENCE}" state="needs" ask="Which wood?" options="${text}"/>`).cards[0]?.options
    expect(options('Larch (recommended); Oak')).toEqual(['Larch', 'Oak'])
    expect(options('Larch; Oak (Recommended); Pine')).toEqual(['Oak', 'Larch', 'Pine'])
    // Brackets that say something else stay, and a choice that is only the mark is none.
    expect(options('Larch (local); Oak (recommended) posts; (recommended)')).toEqual(['Oak posts', 'Larch (local)'])
  })

  it('a merge names the open thread this one joins, alone', () => {
    expect(readCardTags(`Same subject.\n<walnut-card thread="${SEEDS}" merge="${FENCE}"/>`).cards).toEqual([{ thread: SEEDS, merge: FENCE }])
  })

  it('several lines, one per thread, in the reply\'s order', () => {
    const read = readCardTags(`${WORDS}\n\n${cardTagLine(FENCE)}\n${cardTagLine(SEEDS, 'working')}\n`)
    expect(read.cards.map((c) => [c.thread, c.state])).toEqual([[FENCE, 'answered'], [SEEDS, 'working']])
    expect(read.text).toBe(WORDS)
  })

  it('a reply that is only the line leaves no words', () => {
    expect(readCardTags(cardTagLine(FENCE))).toMatchObject({ text: '', tagged: true })
    expect(hasCardLine(cardTagLine(FENCE))).toBe(true)
    expect(hasCardLine(WORDS)).toBe(false)
  })

  it('Windows line ends read the same', () => {
    expect(readCardTags(`${WORDS}\r\n${cardTagLine(FENCE)}\r\n`)).toMatchObject({ text: WORDS, cards: [{ thread: FENCE, state: 'answered' }], errors: [] })
  })
})

describe('a wrong line is not read, and says why in one line', () => {
  const reasonOf = (line: string) => {
    const read = readCardTags(`${WORDS}\n${line}`)
    expect(read.cards, line).toEqual([])
    expect(read.errors, line).toHaveLength(1)
    expect(read.errors[0], line).not.toContain('\n')
    // The line still leaves his screen.
    expect(read.text, line).toBe(WORDS)
    return read.errors[0]
  }
  it.each([
    ['an unknown attribute', `<walnut-card thread="${FENCE}" state="answered" colour="red"/>`, /"colour" is no attribute/],
    ['a state that is none', `<walnut-card thread="${FENCE}" state="finished"/>`, /state is working, waiting, answered, done, needs, not "finished"/],
    ['no state', `<walnut-card thread="${FENCE}"/>`, /state is .* not ""/],
    ['a decision with no thread id: it would be lost', '<walnut-card thread="none" state="needs" ask="Larch or oak?" options="Larch; Oak" kind="user_own" why="his fence"/>', /a decision line names its thread by id .* not "none": .* thread_create/],
    ['an attribute named twice', `<walnut-card thread="${FENCE}" state="working" state="done"/>`, /names state once/],
    ['a tag left open', `<walnut-card thread="${FENCE}" state="answered">`, /one self-closing tag/],
    ['a tag with a closing tag', `<walnut-card thread="${FENCE}" state="answered"></walnut-card>`, /one self-closing tag/],
    ['a quote inside a value', `<walnut-card thread="${FENCE}" state="answered" summary="he said "ok" to it"/>`, /could not be read from .*&quot;/],
    ['a value in single quotes', `<walnut-card thread='${FENCE}' state='answered'/>`, /could not be read/],
    ['seen with another word', `<walnut-card thread="${FENCE}" state="answered" seen="no"/>`, /seen is "yes" or left out/],
    ['a decision with nothing to decide', `<walnut-card thread="${FENCE}" state="needs" options="Larch; Oak"/>`, /state="needs" takes ask=/],
    ['choices on a line that asks nothing', `<walnut-card thread="${FENCE}" state="answered" options="Larch; Oak" kind="spending"/>`, /options, kind go with state="needs" only/],
    ['a merge with more beside it', `<walnut-card thread="${SEEDS}" merge="${FENCE}" state="done"/>`, /merge goes alone/],
    ['a merge into itself', `<walnut-card thread="${FENCE}" merge="${FENCE}"/>`, /merge names another open thread/],
    ['a merge into no thread', `<walnut-card thread="${FENCE}" merge="the fence one"/>`, /merge names another open thread/],
  ])('%s', (_label, line, reason) => {
    expect(reasonOf(line)).toMatch(reason)
  })

  // 2026-11-26, the first hours of real use: 6 of 17 replies with a line named no thread, in turns
  // no message of his started (no note gave the session an id).
  it.each([
    ['the word none', '<walnut-card thread="none" state="answered"/>', 'none'],
    ['a placeholder', '<walnut-card thread="th-placeholder" state="working" summary="The report is updated."/>', 'th-placeholder'],
    ['a made-up id', '<walnut-card thread="th-p572934668" state="done"/>', 'th-p572934668'],
    ['the form copied as it is', '<walnut-card thread="th-..." state="answered"/>', 'th-...'],
    ['a ref of the status question in place of an id', '<walnut-card thread="t1" state="answered"/>', 't1'],
    ['no thread at all', '<walnut-card state="answered"/>', ''],
  ])('a state line with no thread id names no thread, and is no error: %s', (_label, line, value) => {
    const read = readCardTags(`${WORDS}\n${line}\n${cardTagLine(SEEDS, 'working')}`)
    expect(read.unnamed).toEqual([value])
    expect(read.errors).toEqual([])
    expect(read.unread).toEqual([])
    // The other lines still read, and the line leaves his screen like any card line.
    expect(read.cards).toEqual([{ thread: SEEDS, state: 'working' }])
    expect(read.text).toBe(WORDS)
  })

  it('a thread named twice gives no card for it and one reason; the others still read', () => {
    const read = readCardTags(`${WORDS}\n${cardTagLine(FENCE)}\n${cardTagLine(FENCE, 'done')}\n${cardTagLine(SEEDS, 'working')}`)
    expect(read.cards).toEqual([{ thread: SEEDS, state: 'working' }])
    expect(read.errors).toEqual([`2 card lines name ${FENCE}: one line per thread`])
    expect(read.unread).toEqual([{ thread: FENCE, needs: false }])
  })

  it(`more than ${CARD_MAX} lines is a status list: none is read, all leave the text`, () => {
    const ids = Array.from({ length: CARD_MAX + 1 }, (_, i) => `th-00000000000${i}`)
    const read = readCardTags(`${WORDS}\n${ids.map((id) => cardTagLine(id)).join('\n')}`)
    expect(read.cards).toEqual([])
    expect(read.errors).toEqual([`a reply holds at most ${CARD_MAX} card lines, not ${CARD_MAX + 1}`])
    expect(read.text).toBe(WORDS)
    expect(readCardTags(`${WORDS}\n${ids.slice(0, CARD_MAX).map((id) => cardTagLine(id)).join('\n')}`).cards).toHaveLength(CARD_MAX)
  })
})

// 2026-11-25, a live walk: told by the store to "Pass since_you_wrote", a session wrote
// since_you_wrote="..." into its line, and the whole line was dropped as an unknown attribute.
describe('a decision line carries what a write after his words needs', () => {
  const NEEDS = `thread="${FENCE}" state="needs" ask="One big pot or three small ones?" options="One big pot; Three small pots" kind="spending" why="the big pot costs twice the budget he set"`

  it('since and decision ride a decision line', () => {
    const read = readCardTags(`${WORDS}\n<walnut-card ${NEEDS} since="Dropped the planter comparison as he asked." decision="new"/>`)
    expect(read.errors).toEqual([])
    expect(read.cards[0]).toMatchObject({ since: 'Dropped the planter comparison as he asked.', decision: 'new' })
    expect(readCardTags(`<walnut-card ${NEEDS} decision="same"/>`).cards[0]?.decision).toBe('same')
  })

  it('the op\'s own field names read as the same attributes, one table', () => {
    expect(CARD_ALIASES).toEqual({ since_you_wrote: 'since', user_kind: 'kind', user_kind_why: 'why' })
    const read = readCardTags(`<walnut-card thread="${FENCE}" state="needs" ask="Which wood?" options="Larch; Oak" user_kind="spending" user_kind_why="oak costs twice the budget" since_you_wrote="Checked both suppliers."/>`)
    expect(read.errors).toEqual([])
    expect(read.cards).toEqual([{ thread: FENCE, state: 'needs', ask: 'Which wood?', options: ['Larch', 'Oak'], kind: 'spending', why: 'oak costs twice the budget', since: 'Checked both suppliers.' }])
  })

  it.each([
    ['a field and its alias both', `<walnut-card ${NEEDS} since="Checked." since_you_wrote="Checked again."/>`, /names since once/],
    ['kind and user_kind both', `<walnut-card thread="${FENCE}" state="needs" ask="Which wood?" kind="spending" user_kind="spending"/>`, /names kind once/],
    ['a decision that is neither', `<walnut-card ${NEEDS} decision="maybe"/>`, /decision is "same" or "new", not "maybe"/],
    ['since on a line that asks nothing', `<walnut-card thread="${FENCE}" state="answered" since="Checked."/>`, /since go with state="needs" only/],
    ['decision on a line that asks nothing', `<walnut-card thread="${FENCE}" state="working" decision="same"/>`, /decision go with state="needs" only/],
    ['an alias beside a merge', `<walnut-card thread="${FENCE}" merge="${SEEDS}" since_you_wrote="Checked."/>`, /merge goes alone/],
    ['a field of the op a line does not carry', `<walnut-card ${NEEDS} supersedes="${SEEDS}"/>`, /"supersedes" is no attribute/],
  ])('%s is refused', (_label, line, reason) => {
    const read = readCardTags(line)
    expect(read.cards).toEqual([])
    expect(read.errors[0]).toMatch(reason)
  })

  it('a line not read still names its thread, and whether it asked him to decide', () => {
    const read = readCardTags(`${WORDS}\n<walnut-card ${NEEDS} colour="red"/>\n<walnut-card thread="${SEEDS}" state="finished"/>`)
    expect(read.cards).toEqual([])
    expect(read.unread).toEqual([{ thread: FENCE, needs: true }, { thread: SEEDS, needs: false }])
    expect(readCardTags('<walnut-card thread="fence" state="needs"/>').unread).toEqual([])
  })
})

describe('where a card line counts', () => {
  it(`with at most ${CARD_TAIL_LINES} other lines after it: the tasks line and the agent-ack line may follow`, () => {
    const after = ['<walnut-about tasks="abc-123"/>', NO_ACTION_TAG, 'One more line.']
    expect(readCardTags([WORDS, cardTagLine(FENCE), ...after].join('\n'))).toMatchObject({ cards: [{ thread: FENCE }], text: [WORDS, ...after].join('\n') })
    const tooFar = readCardTags([WORDS, cardTagLine(FENCE), ...after, 'And another.'].join('\n'))
    expect(tooFar.cards).toEqual([])
    // It was meant, in the wrong place: the reason says where it goes. He does not see it there either.
    expect(tooFar.errors).toEqual([`the card line for ${FENCE} is not among the reply's last lines: move it to the end`])
    expect(tooFar).toMatchObject({ tagged: true, text: [WORDS, ...after, 'And another.'].join('\n') })
  })

  it('a line further up leaves one blank line between what stood around it', () => {
    const rest = 'Then the beds.\nThen the gate.\nThen the path.\nThen the shed.'
    for (const [text, shown] of [
      [`${WORDS}\n\n${cardTagLine(FENCE)}\n\n${rest}`, `${WORDS}\n\n${rest}`],
      [`${WORDS}\n${cardTagLine(FENCE)}\n\n${rest}`, `${WORDS}\n\n${rest}`],
      [`${WORDS}\n\n${cardTagLine(FENCE)}\n${rest}`, `${WORDS}\n\n${rest}`],
      [`${WORDS}\n${cardTagLine(FENCE)}\n${rest}`, `${WORDS}\n${rest}`],
      [`${cardTagLine(FENCE)}\n\n${rest}`, rest],
    ]) {
      expect(readCardTags(text).text, text).toBe(shown)
      expect(stripInternalLines(text), text).toBe(shown)
      expect(stripInternalLines(text, true), text).toBe(shown)
    }
  })

  it('a line further up for a thread the last lines name again is not an error', () => {
    const read = readCardTags([cardTagLine(FENCE, 'working'), 'One.', 'Two.', 'Three.', 'Four.', cardTagLine(FENCE)].join('\n'))
    expect(read.cards).toEqual([{ thread: FENCE, state: 'answered' }])
    expect(read.errors).toEqual([])
  })

  it('never inside a code fence, an indented block or a sentence', () => {
    for (const text of [
      `The line looks like this:\n\`\`\`\n${cardTagLine(FENCE)}\n\`\`\``,
      `The line looks like this:\n~~~xml\n${cardTagLine(FENCE)}\n~~~`,
      `The line looks like this:\n\n    ${cardTagLine(FENCE)}`,
      `The line looks like this:\n\t${cardTagLine(FENCE)}`,
      `I end my replies with ${cardTagLine(FENCE)} now.`,
      `${cardTagLine(FENCE)} is the line.`,
      // A fence still open at the reply's end: what follows it is code.
      `Here:\n\`\`\`\ncode\n${cardTagLine(FENCE)}`,
    ]) {
      expect(readCardTags(text), text).toEqual({ text, cards: [], errors: [], unread: [], unnamed: [], tagged: false })
      expect(stripInternalLines(text), text).toBe(text)
    }
  })

  it('right after a code block that closed', () => {
    const text = `Here is the plan:\n\`\`\`\nplant\n\`\`\`\n${cardTagLine(FENCE)}`
    expect(readCardTags(text)).toMatchObject({ text: 'Here is the plan:\n```\nplant\n```', cards: [{ thread: FENCE }] })
  })

  it('a tag of another name is not one', () => {
    for (const line of [`<walnut-cards thread="${FENCE}" state="answered"/>`, `<walnut-card-x thread="${FENCE}" state="answered"/>`, `<walnut-thread id="${FENCE}" title="Fence"/>`]) {
      expect(readCardTags(`${WORDS}\n${line}`).tagged, line).toBe(false)
    }
  })
})

describe('he never sees the line', () => {
  const REPLIES: Array<[string, string, string]> = [
    ['after the words', `${WORDS}\n\n${cardTagLine(FENCE)}`, WORDS],
    ['two of them', `${WORDS}\n${cardTagLine(FENCE)}\n${cardTagLine(SEEDS, 'working')}`, WORDS],
    ['a decision, which asks him something', `${WORDS}\n<walnut-card thread="${FENCE}" state="needs" ask="Which wood?" options="Larch; Oak" kind="spending" why="twice the budget"/>`, WORDS],
    ['one that cannot be read', `${WORDS}\n<walnut-card thread="oops" state="answered"/>`, WORDS],
    ['a value with a ">" in it', `${WORDS}\n<walnut-card thread="${FENCE}" state="answered" summary="a -> b"/>`, WORDS],
    ['before the tasks line', `${WORDS}\n${cardTagLine(FENCE)}\n<walnut-about tasks="abc-123"/>`, `${WORDS}\n<walnut-about tasks="abc-123"/>`],
    ['after a status report older habits still write', `${WORDS}\n${cardTagLine(FENCE)}\nFOR_USER_STATE: working\nFOR_USER_NOW: a\nFOR_USER_NEXT: b\nFOR_USER_WAITING_ON: c`, WORDS],
    ['before a thread line older habits still write', `Done. It is on the board.\n${cardTagLine(FENCE)}\n${SEEDS}: working \u00b7 comparing`, 'Done. It is on the board.'],
    ['one line of words, then the line: the words are the whole reply', `Done.\n${cardTagLine(FENCE)}`, 'Done.'],
    ['alone', cardTagLine(FENCE), ''],
  ]
  it.each(REPLIES)('stripInternalLines: %s', (_label, text, shown) => {
    expect(stripInternalLines(text)).toBe(shown)
    expect(stripInternalLines(text, true)).toBe(shown)
    expect(splitInternalLines(text).text).toBe(shown)
    expect(splitInternalLines(text).hidden).toContain('<walnut-card')
  })

  it('the web chat, the thread cards and the session find (stripTurnMarker) drop it, with the tasks line and the marker', () => {
    expect(stripTurnMarker(`${WORDS}\n${cardTagLine(FENCE)}\n<walnut-about tasks="abc-123"/>`)).toBe(WORDS)
    expect(stripTurnMarker(`${WORDS}\n<walnut-about tasks="abc-123"/>\n${cardTagLine(FENCE)}`)).toBe(WORDS)
    expect(stripTurnMarker(`${cardTagLine(FENCE)}\n${NO_ACTION_TAG}`)).toBe('')
  })

  it('the agent-ack line still folds its turn with a card line after it', () => {
    expect(readTurnMarker(`${NO_ACTION_TAG}\n${cardTagLine(FENCE)}`)).toEqual({ text: '', noAction: true })
    expect(readTurnMarker(`${WORDS}\n${cardTagLine(FENCE)}`)).toEqual({ text: WORDS, noAction: false })
  })

  it('words read for a person (a status line, an approval\'s reason) never hold it, whatever its values hold', () => {
    const line = `<walnut-card thread="${FENCE}" state="answered" summary="a -> b, then c > d"/>`
    expect(withoutWalnutControl(`${WORDS}\n${line}`).trim()).toBe(WORDS)
    expect(hasWordsBeyondControl(line)).toBe(false)
    expect(hasWordsBeyondControl(`  ${line}\r\n`)).toBe(false)
  })

  it('while a reply streams in, no step of the line shows, and the words before it stay', () => {
    for (const reply of [`${WORDS}\n\n${cardTagLine(FENCE)}`, `${WORDS}\n${cardTagLine(FENCE)}\n<walnut-card thread="${SEEDS}" state="working" summary="a -> b"/>\n${NO_ACTION_TAG}`, cardTagLine(FENCE)]) {
      for (let end = 1; end <= reply.length; end++) {
        const part = reply.slice(0, end)
        // The first two leave the agent-ack line to the layer that holds it (turn-end-marker.ts); the chat's own reader shows no tag at all.
        const CARD = /walnut-c|thread=|th-1a|th-0f/
        for (const [name, shown, never] of [['stripCardTags', stripCardTags(part, true), CARD], ['stripInternalLines', stripInternalLines(part, true), CARD], ['stripTurnMarker', stripTurnMarker(part, true), /<|walnut|thread=|th-1a/]] as const) {
          expect(shown, `${name} at ${end}: ${JSON.stringify(part)}`).not.toMatch(never)
          if (end >= WORDS.length && reply.startsWith(WORDS)) expect(shown.startsWith(WORDS), `${name} at ${end}`).toBe(true)
        }
      }
    }
  })

  it('while a reply streams in, a line that began the tag but is another tag, or is code, shows', () => {
    expect(stripCardTags(`${WORDS}\n<walnut-cards are`, true)).toBe(`${WORDS}\n<walnut-cards are`)
    expect(stripCardTags('```xml\n<walnut-card thread="th', true)).toBe('```xml\n<walnut-card thread="th')
    // A finished reply holds nothing back.
    expect(stripCardTags(`${WORDS}\n<walnut-card thread="th`)).toBe(`${WORDS}\n<walnut-card thread="th`)
  })

  it('while a reply streams in, a last line indented as code is never held back: it would show again at the end', () => {
    // Four spaces, or a tab: an indented block, where the whole line is not a card line either.
    for (const lead of ['    ', '     ', '\t', ' \t', '\u00a0']) {
      const whole = `Run this:\n\n${lead}${cardTagLine(FENCE)}`
      for (let end = whole.length - cardTagLine(FENCE).length; end <= whole.length; end++) {
        const part = whole.slice(0, end)
        expect(stripCardTags(part, true), JSON.stringify(part)).toBe(part)
        // The chat's whole strip too, for the leads its report layer does not hold on its own (it takes up to three of any space as a tag's indent).
        if (/^(?: {4,}|\t)$/.test(lead)) expect(stripInternalLines(part, true), JSON.stringify(part)).toBe(part)
      }
      expect(readCardTags(whole).tagged, JSON.stringify(lead)).toBe(false)
    }
    // Up to three spaces in it is a card line, held from its first characters on.
    for (const lead of ['', ' ', '   ']) {
      expect(stripCardTags(`${WORDS}\n${lead}<walnut-card thr`, true), JSON.stringify(lead)).toBe(WORDS)
      expect(readCardTags(`${WORDS}\n${lead}${cardTagLine(FENCE)}`).cards, JSON.stringify(lead)).toHaveLength(1)
    }
  })

  it('a reader that goes line by line is told which lines are card lines by the same rule', () => {
    const line = cardTagLine(FENCE)
    expect(cardLinesOf([WORDS, line, '```', line, '```', `    ${line}`, `see ${line}`, ` ${line}\r`])).toEqual([false, true, false, false, false, false, false, true])
  })
})
