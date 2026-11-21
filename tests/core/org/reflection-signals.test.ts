/**
 * Step one of the reflection (src/core/org/reflection/signals.ts): which of the user's messages are
 * worth a judge call. Chinese test data is written as \u escapes (repo rule: no Chinese in code).
 */
import { describe, it, expect } from 'vitest'
import { isFollowUp, isFrustrated, manyRoundWindows, messageSignals, parseCardAnswer, recommends, MANY_ROUNDS_QUIET_MS } from '../../../src/core/org/reflection/signals.js'
import { asksForEnglish, measureLanguage, readsNotChinese, wantsChinese } from '../../../src/core/org/reflection/language.js'

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

  it('reads the v2 signals: why and again, a regression, built different, shown twice (English and Chinese)', () => {
    expect(isFrustrated('why did you ask me again')).toBe(true)
    expect(isFrustrated('it keeps failing on the same step')).toBe(true)
    // "wei shen me you huai le" (why is it broken again)
    expect(messageSignals('\u4e3a\u4ec0\u4e48\u53c8\u574f\u4e86')).toEqual(['regression', 'frustration'])
    expect(messageSignals('the reply used to show under the card')).toEqual(['regression'])
    // "bu shi wo yao de" (not what I want)
    expect(messageSignals('\u8fd9\u4e0d\u662f\u6211\u8981\u7684')).toContain('built_different')
    expect(messageSignals('the lead is listed three times')).toEqual(['duplicate_display'])
    // "chu xian le san ci" (showed up three times)
    expect(messageSignals('\u51fa\u73b0\u4e86\u4e09\u6b21')).toContain('duplicate_display')
    expect(messageSignals('please add a column for the dock')).toEqual([])
  })

  it('splits a card answer into the agent\'s ask and his words', () => {
    expect(parseCardAnswer('Answer to "Ship it now?": Yes. go')).toEqual({ ask: 'Ship it now?', words: 'Yes. go' })
    expect(parseCardAnswer('ship it now')).toBeNull()
  })

  it('measures an answer\'s language on its prose only', () => {
    expect(wantsChinese('Talk to the user in Chinese; code stays English.')).toBe(true)
    expect(wantsChinese(null)).toBe(false)
    expect(wantsChinese('Answer in English.')).toBe(false)
    const english = 'The page now loads the dock list first and the schedule after it, which makes it about a second faster for every visitor. '.repeat(3)
    expect(readsNotChinese(english)).not.toBeNull()
    // Short answers, and code, paths and identifiers, are never measured.
    expect(readsNotChinese('Done, see the log.')).toBeNull()
    const code = '\u597d\u7684\uff0c\u6539\u597d\u4e86\u3002\n```ts\n' + 'const pierPage = loadDockList(options.schedule_first);\n'.repeat(20) + '```\nsrc/web/pier/page.tsx and https://example.com/a/b'
    expect(measureLanguage(code).letters).toBeLessThan(20)
    expect(readsNotChinese(code)).toBeNull()
  })

  it('leaves loose words alone: an operation, a plain go-ahead, a plain question about an older version', () => {
    // "cao zuo" (operate): never swearing
    expect(messageSignals('\u8fd9\u4e2a\u64cd\u4f5c\u600e\u4e48\u505a')).toEqual([])
    // "wo cao" is
    expect(isFrustrated('\u6211\u64cd')).toBe(true)
    expect(messageSignals('just go ahead')).toEqual([])
    // "yi qian de ban ben zai na" (where is the older version)
    expect(messageSignals('\u4ee5\u524d\u7684\u7248\u672c\u5728\u54ea')).toEqual([])
    // "yi qian ke yi" (it could before) is a regression
    expect(messageSignals('\u4ee5\u524d\u53ef\u4ee5\u6298\u53e0')).toContain('regression')
    // a bare "you" (again) inside a plain sentence, and "mei le" (no more) as plain news
    expect(messageSignals('\u53c8\u4e00\u4e2a\u65b0\u4efb\u52a1')).toEqual([])
    expect(messageSignals('\u95ee\u9898\u6ca1\u4e86')).toEqual([])
    // "zen me you mei le" (why is it gone again)
    expect(messageSignals('\u600e\u4e48\u53c8\u6ca1\u4e86')).toContain('regression')
    expect(messageSignals('I lost track, which one is it')).toEqual([])
    expect(messageSignals('the reply is gone')).toEqual(['regression'])
    expect(messageSignals('the original plan was fine')).toEqual([])
    expect(messageSignals('bring back the original layout')).toEqual(['regression'])
    expect(messageSignals('the original layout is better')).toEqual(['regression'])
    expect(messageSignals('two of them are done')).toEqual([])
    expect(messageSignals('same as yesterday, unified view please')).toEqual([])
    // "wen wo" (ask me) alone is no complaint; "wei shen me wen wo" (why ask me) is
    expect(messageSignals('\u6709\u95ee\u9898\u95ee\u6211')).toEqual([])
    expect(messageSignals('\u4e3a\u4ec0\u4e48\u95ee\u6211')).toContain('not_for_user')
  })

  it('reads the setting and his asks for English, and strips what is not prose', () => {
    expect(wantsChinese('Reply in Chinese.')).toBe(true)
    // "yong zhong wen hui da"
    expect(wantsChinese('\u7528\u4e2d\u6587\u56de\u7b54')).toBe(true)
    expect(wantsChinese('I like Chinese tea')).toBe(false)
    expect(wantsChinese('Talk in Chinese; reply in English to reviewers.')).toBe(false)
    expect(asksForEnglish('please draft the PR description')).toBe(true)
    expect(asksForEnglish('how is the page')).toBe(false)
    const filler = 'the dock list loads first and the schedule after it for every visitor '.repeat(4)
    for (const wrapped of [
      `<div class="card">${filler}</div>`, `    ${filler}`, `> ${filler}`, `- [${filler}](task:abc123)`,
    ]) expect(readsNotChinese(wrapped)).toBeNull()
  })
})

describe('unclear asks and unreviewed designs (2026-11-21)', () => {
  it('reads his "what are you talking about" and a call for a review', () => {
    expect(messageSignals('what are u talk about')).toContain('unclear_ask')
    expect(messageSignals('\u770b\u4e0d\u61c2\u4f60\u5728\u8bf4\u4ec0\u4e48')).toContain('unclear_ask')
    expect(messageSignals('The design need ot be at least reviewed once')).toContain('unreviewed_design')
    expect(messageSignals('\u6309\u94ae\u538b\u5728\u83dc\u5355\u56fe\u6807\u4e0a')).toContain('unreviewed_design')
  })
  it('leaves plain messages alone', () => {
    expect(messageSignals('please review the pull request when it is ready')).not.toContain('unreviewed_design')
    expect(messageSignals('what is the plan for tomorrow')).not.toContain('unclear_ask')
  })
})
