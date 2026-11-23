/**
 * Voice mode's answer reader (web/src/voice/voice-answer.ts): the session's stream in,
 * pieces and the turn's end out, in order. The server's cleaning (/api/v1/voice/spoken)
 * is faked; non-ASCII test data is written with \u escapes (repo language rule).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

interface SpokenCall { text: string; opts: { piece?: boolean; language?: string } }
const calls: SpokenCall[] = []
/** When set, the next calls wait for `release()`: a slow server. */
let gate: Promise<void> | null = null

vi.mock('../../../web/src/api/voice', () => ({
  spokenReply: async (text: string, opts: { piece?: boolean; language?: string } = {}) => {
    calls.push({ text, opts })
    if (gate) await gate
    // The server's rules, simplified: the part before a rule, its language from the words.
    const head = text.split('\n---')[0]!.replace(/\n/g, ' ').trim()
    if (!head) return null
    const language = opts.language ?? (/[\u4e00-\u9fff]{2}/.test(head) ? 'zh-CN' : 'en-US')
    if (opts.piece || !text.includes('\n---')) return { text: head, language, truncated: false, chunks: [head] }
    const rest = language.startsWith('zh') ? 'ZH-REST' : 'The rest is on screen.'
    return { text: `${head} ${rest}`, language, truncated: true, chunks: [head, rest], rest }
  },
  speakPiece: async () => new ArrayBuffer(0),
  SpeakError: class extends Error {},
}))

import { clearLanguage, VoiceAnswer } from '../../../web/src/voice/voice-answer'
import type { VoiceEvent, VoiceState } from '../../../web/src/voice/conversation-machine'

const SID = 'session-1'
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)) }

function setup(state: Partial<VoiceState> = {}) {
  const events: VoiceEvent[] = []
  let current: VoiceState = { phase: 'waiting', heard: false, lastHeard: null, lastSpoken: null, error: null, take: 1, turn: true, ...state }
  const answer = new VoiceAnswer({ sessionId: () => SID, state: () => current, gen: () => 1, dispatch: (e) => { events.push(e) } })
  const delta = (text: string, msgId = 'm1') => answer.onDelta({ sessionId: SID, delta: text, msgId })
  const result = (text: string, extra: Record<string, unknown> = {}) => answer.onResult({ sessionId: SID, result: text, ...extra })
  return { answer, events, delta, result, set: (s: Partial<VoiceState>) => { current = { ...current, ...s } } }
}

beforeEach(() => { calls.length = 0; gate = null })

describe('voice answer', () => {
  it('cleans each part as a piece and hands the pieces on in order, a slow first one included', async () => {
    const { answer, events, delta } = setup()
    answer.sent()
    let open!: () => void
    gate = new Promise((r) => { open = r })
    delta('First part. ')
    delta('Second part. ')
    await settle()
    expect(events).toEqual([])
    gate = null
    open()
    await settle()
    expect(events).toEqual([{ type: 'piece', spoken: 'First part.' }, { type: 'piece', spoken: 'Second part.' }])
    expect(calls.every((c) => c.opts.piece)).toBe(true)
  })

  it('a streamed result is not read again; a cut adds the rest line in the language that was said', async () => {
    const { answer, events, delta, result } = setup()
    answer.sent()
    const zh = '\u597d\u3002'
    const zhMore = '\u6d4b\u8bd5\u901a\u8fc7\u4e86\u3002'
    delta(zh)
    delta(`${zhMore}\n\n---\n\nEnglish detail text that is long.`)
    result(`${zh}${zhMore}\n\n---\n\nEnglish detail text that is long.`)
    await settle()
    expect(events.map((e) => e.type)).toEqual(['piece', 'piece', 'reply'])
    expect(events[2]).toEqual({ type: 'reply', spoken: 'ZH-REST', streamed: true })
    // One character was enough for a Chinese voice, and the rest line was asked in it.
    expect(answer.wordsFor(zh)?.language).toBe('zh-CN')
    expect(calls.at(-1)!.opts.language).toBe('zh-CN')
  })

  it('the same words twice: a new turn is read, a true repeat with no turn running is not', async () => {
    const { answer, events, delta, result, set } = setup()
    answer.sent()
    result('All tests passed.')
    await settle()
    set({ turn: false, phase: 'listening' })
    // The next turn streams the same words: its answer, read.
    answer.sent()
    set({ turn: true, phase: 'waiting' })
    delta('All tests passed.', 'm2')
    result('All tests passed.')
    await settle()
    expect(events.filter((e) => e.type === 'reply')).toHaveLength(2)
    // Announced again with nothing running: ignored, so nothing else changes.
    set({ turn: false, phase: 'listening' })
    result('All tests passed.')
    await settle()
    expect(events.filter((e) => e.type === 'reply')).toHaveLength(2)
  })

  it('a new turn with the same words and no streamed text is read when it comes later', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    try {
      const { answer, events, result } = setup()
      answer.sent()
      result('All tests passed.')
      await settle()
      answer.sent()
      now.mockReturnValue(1_020_000)
      result('All tests passed.')
      await settle()
      expect(events).toEqual([{ type: 'reply', spoken: 'All tests passed.' }, { type: 'reply', spoken: 'All tests passed.' }])
    } finally { now.mockRestore() }
  })

  it('a repeat that arrives after the next send keeps that send\'s reader', async () => {
    const { answer, events, delta, result, set } = setup()
    answer.sent()
    result('Done.')
    await settle()
    answer.sent()
    set({ turn: true })
    result('Done.')
    delta('Next answer. ', 'm2')
    await settle()
    expect(events.at(-1)).toEqual({ type: 'piece', spoken: 'Next answer.' })
  })

  it('a barge-in while the turn is finishing drops its last pieces and its rest line', async () => {
    const { answer, events, delta, result } = setup()
    answer.sent()
    delta('Said already. Last words')
    await settle()
    let open!: () => void
    gate = new Promise((r) => { open = r })
    // The end releases the unfinished tail; the person talks over it while it is cleaned.
    result('Said already. Last words')
    answer.mute()
    gate = null
    open()
    await settle()
    expect(events).toEqual([{ type: 'piece', spoken: 'Said already.' }, { type: 'reply', spoken: null, streamed: true }])
    // The same for a rest line still on its way.
    const b = setup()
    b.answer.sent()
    b.delta('Said already. ')
    await settle()
    gate = new Promise((r) => { open = r })
    b.result('Missed.\n---\ndetail')
    await settle()
    b.answer.mute()
    gate = null
    open()
    await settle()
    expect(b.events.at(-1)).toEqual({ type: 'reply', spoken: null, streamed: true })
  })

  it('a result that matches no streamed message is never read whole after its pieces', async () => {
    const { answer, events, delta, result } = setup()
    answer.sent()
    delta('Checking now. ', 'm1')
    // The final message's increments were missed.
    result('The build passed and here is more.')
    await settle()
    expect(events).toEqual([{ type: 'piece', spoken: 'Checking now.' }, { type: 'reply', spoken: null, streamed: true }])
    // With a cut in it, only its rest line.
    const b = setup()
    b.answer.sent()
    b.delta('Checking now. ', 'm1')
    b.result('Missed words.\n---\ndetail')
    await settle()
    expect(b.events.at(-1)).toEqual({ type: 'reply', spoken: 'The rest is on screen.', streamed: true })
  })

  it('nothing streamed: the whole answer, as before', async () => {
    const { answer, events, result } = setup()
    answer.sent()
    result('Two meetings.')
    await settle()
    expect(events).toEqual([{ type: 'reply', spoken: 'Two meetings.' }])
    expect(answer.last()?.text).toBe('Two meetings.')
  })

  it('a muted turn whose message was answered before a new send ends only that turn', async () => {
    const { answer, events, delta, result } = setup()
    answer.sent()
    delta('Old answer goes on. ', 'm1')
    await settle()
    answer.mute()
    answer.sent()
    result('Old answer goes on. ')
    await settle()
    expect(events.at(-1)).toEqual({ type: 'reply', spoken: null, streamed: true, continues: true })
    // The newer turn is read.
    delta('New answer. ', 'm2')
    await settle()
    expect(events.at(-1)).toEqual({ type: 'piece', spoken: 'New answer.' })
  })

  it('the bar Stop: its interrupted result reads nothing', async () => {
    const { answer, events, result } = setup()
    answer.sent()
    answer.runStopped()
    result('Half.', { interrupted: true })
    await settle()
    expect(events).toEqual([{ type: 'reply', spoken: null }])
  })

  it('Replay gets everything said in the last turn', async () => {
    const { answer, delta, result } = setup()
    answer.sent()
    delta('One. ')
    delta('Two. ')
    result('One. Two. ')
    await settle()
    expect(answer.last()).toMatchObject({ text: 'One. Two.', chunks: ['One.', 'Two.'] })
  })

  it('tells a language only when the words show it', () => {
    expect(clearLanguage('OK.')).toBeNull()
    expect(clearLanguage('\u597d\u3002')).toBe('zh-CN')
    expect(clearLanguage('The build passed with two warnings.')).toBe('en-US')
    expect(clearLanguage('\u3067\u3059\u3002')).toBe('ja-JP')
  })
})
