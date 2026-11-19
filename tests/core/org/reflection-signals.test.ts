/**
 * Step one of the reflection (src/core/org/reflection/signals.ts): which of the user's messages are
 * worth a judge call. Chinese test data is written as \u escapes (repo rule: no Chinese in code).
 */
import { describe, it, expect } from 'vitest'
import { isFollowUp, isFrustrated, manyRoundWindows, messageSignals, recommends, MANY_ROUNDS_QUIET_MS } from '../../../src/core/org/reflection/signals.js'

// "bu shi bu shi bu shi, ni zhe ge xiang fa wan quan shi cuo de" (no no no, this idea is completely wrong)
const ANGRY_ZH = '\u4e0d\u662f\u4e0d\u662f\u4e0d\u662f\uff0c\u4f60\u8fd9\u4e2a\u60f3\u6cd5\u5b8c\u5168\u662f\u9519\u7684\u3002'
// "wo de jian yi shi bao chi xian zai zhe yang" (my recommendation is to keep it as it is)
const RECOMMEND_ZH = '\u6211\u7684\u5efa\u8bae\u662f\u4fdd\u6301\u73b0\u5728\u8fd9\u6837\u3002'
// "bu dui, yong xin de ban ben" (no, use the new version)
const OVERRULE_ZH = '\u4e0d\u5bf9\uff0c\u7528\u65b0\u7684\u7248\u672c'
// "suo yi, xian zai shi zen yang le?" (so, where does it stand now?)
const FOLLOW_UP_ZH = '\u6240\u4ee5\uff0c\u73b0\u5728\u662f\u600e\u6837\u4e86\uff1f'

describe('reflection signals', () => {
  it('reads frustration in English and Chinese, and leaves plain messages alone', () => {
    expect(isFrustrated('you are ridiculous')).toBe(true)
    expect(isFrustrated('it terminated because of safety why???')).toBe(true)
    expect(isFrustrated('i login but please reflect be careful')).toBe(true)
    expect(isFrustrated(ANGRY_ZH)).toBe(true)
    expect(isFrustrated('yes rename everything to the new name')).toBe(false)
    expect(isFrustrated('go')).toBe(false)
  })

  it('counts an overrule only when the turn before recommended or asked', () => {
    expect(recommends(RECOMMEND_ZH)).toBe(true)
    expect(recommends('I recommend option B. Do you want me to start?')).toBe(true)
    expect(messageSignals(OVERRULE_ZH, RECOMMEND_ZH)).toEqual(['overruled'])
    // The same words after a status line are no overrule.
    expect(messageSignals(OVERRULE_ZH, 'The build finished and the tests passed.')).toEqual([])
    // Not known yet: a candidate, read again once the turn is.
    expect(messageSignals(OVERRULE_ZH)).toEqual(['overruled'])
    expect(messageSignals(ANGRY_ZH, RECOMMEND_ZH)).toEqual(['frustration', 'overruled'])
  })

  it('finds a closed many-round window with follow-ups, once, and none while the talk goes on', () => {
    const t0 = Date.parse('2026-11-19T08:00:00Z')
    const at = (min: number) => new Date(t0 + min * 60_000).toISOString()
    const texts = ['why did it stop?', 'so what now', FOLLOW_UP_ZH, 'ok', 'and the logs?', 'why???', 'fine']
    const msgs = texts.map((text, i) => ({ id: `m${i}`, at: at(i * 5), text }))
    expect(isFollowUp(FOLLOW_UP_ZH)).toBe(true)
    // The last message was 2 minutes ago: still talking, nothing to judge.
    expect(manyRoundWindows(msgs, t0 + 32 * 60_000)).toEqual([])
    const quiet = t0 + 30 * 60_000 + MANY_ROUNDS_QUIET_MS
    const windows = manyRoundWindows(msgs, quiet)
    expect(windows).toHaveLength(1)
    expect(windows[0].ids).toEqual(msgs.map((m) => m.id))
    expect(windows[0].followUps).toBeGreaterThanOrEqual(3)
    // Few messages, or no follow-ups, is no window.
    expect(manyRoundWindows(msgs.slice(0, 4), quiet)).toEqual([])
    expect(manyRoundWindows(msgs.map((m) => ({ ...m, text: 'ok' })), quiet)).toEqual([])
  })
})
