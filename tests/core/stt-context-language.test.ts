/**
 * A take a Chinese speaker gave comes back in Chinese, even when the context's
 * English terms tipped the engine into English (2026-11-20, the user's own
 * recordings: 2 of 171 takes in a day were written as English translations; one
 * learned phrase or one word of the 40-term context was enough to tip them).
 * The engine hears the clip again with the language set to Chinese; a take
 * really spoken in English stays English and keeps its first answer.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// "I'm not blaming you, but this thing is called answered" in Chinese, with its English words.
const ZH = '哦，不是我错怪你了，但是这有一个东西叫做 answered，为什么有两个呀'
const EN = 'Oh, not me. I blame you. But the problem is, this has a thing called answered.'
// A 62 s take of 2026-11-19 (neutral words): its first stretch came back as English
// sentences, its last line in Chinese ("will there be no network later? how do others do it?").
const PART_EN = 'Okay. Okay. Then we make a big design, right? Because this thing involves very, very many changes. ' +
  'That is to say, later our daemon is more lightweight, right? Why does this plugin job need the daemon to manage it? ' +
  'Should the server not manage it? The daemon is more stable. '
const PART = PART_EN + '\u751a\u81f3\u4e4b\u540e\u662f\u4e0d\u662f\u5c31\u6ca1\u6709\u7f51\u4e86\uff1f\u522b\u4eba\u662f\u600e\u4e48\u505a\u7684\u5462\uff1f'
const EN_REAL = 'So the interview is about payments, and the system design round comes after lunch.'

const calls: string[] = []
let withContext = EN
let asChinese = ZH // the answer heard as Chinese
let slowMs = 0
let plainFails = false
vi.mock('../../src/core/stt/engine-mlx.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createMlxEngine: () => ({
    name: 'mlx',
    isAvailable: async () => ({ available: true }),
    transcribe: async (req: { language?: string }) => {
      const asZh = req.language === 'zh'
      calls.push(req.language ?? 'auto')
      if (asZh && plainFails) throw new Error('engine timed out')
      return { text: asZh ? asChinese : withContext, durationMs: asZh ? 30 : slowMs || 40 }
    },
  }),
}))

import { _resetLanguageMemoryForTest, transcribeAudio } from '../../src/core/stt/index.js'
import { chineseHearingWins, cjkShare, longestEnglishRun, mayBeTranslated, readAsChinese, readAsEnglish, TRANSLATED_RUN_WORDS } from '../../src/core/stt/context-language.js'
import { _setTitleTermsForTest } from '../../src/core/stt/user-terms.js'
import { editPairs, termShaped } from '../../src/core/stt/learn-from-sends.js'
import type { Config } from '../../src/core/types.js'

const CONTEXT = 'Marina, Acme, Walnut, cloud companion, daemon, bun, custom, UI, AI'
const config = { stt: { engine: 'mlx', mlx_python_path: '/nonexistent/python' } } as unknown as Config

describe('reading the language of a transcription', () => {
  it('counts a Chinese character and an English word as one unit each', () => {
    expect(cjkShare(ZH).share).toBeGreaterThan(0.9)
    expect(cjkShare(EN).share).toBe(0)
    expect(cjkShare('').units).toBe(0)
  })

  it('mixed Chinese speech with English terms is Chinese, never English', () => {
    // "Every day look at our voice and text once, then monitor these things" in Chinese.
    const mixed = '每天看一遍我们的这个 voice，然后 text，就首先你要 monitor 这些东西'
    expect(readAsEnglish(mixed)).toBe(false)
    expect(readAsChinese(mixed)).toBe(true)
  })

  it('a sentence of English reads as English; a word or two does not decide', () => {
    expect(readAsEnglish(EN)).toBe(true)
    expect(readAsEnglish('ok thanks')).toBe(false)
    expect(readAsChinese('ok thanks')).toBe(false)
  })
})

describe('a take translated only in part', () => {
  it('a paragraph of English inside a Chinese take is worth hearing again', () => {
    expect(readAsEnglish(PART)).toBe(false)
    expect(longestEnglishRun(PART)).toBeGreaterThanOrEqual(TRANSLATED_RUN_WORDS)
    expect(mayBeTranslated(PART)).toBe(true)
  })

  it('the user\'s real mixed speech is never heard twice', () => {
    // His longest real English run in 40 takes was 13 words; terms sit between Chinese.
    const mixed = '\u6211\u89c9\u5f97 the system design round comes after lunch and then we talk about payments \u5bf9\u5427'
    expect(longestEnglishRun(mixed)).toBe(13)
    expect(mayBeTranslated(mixed)).toBe(false)
    expect(mayBeTranslated(ZH)).toBe(false)
  })

  it('the Chinese hearing wins only with clearly more Chinese than the first', () => {
    expect(chineseHearingWins(PART, ZH)).toBe(true)
    expect(chineseHearingWins(EN, ZH)).toBe(true)
    // A Chinese take that really quoted a paragraph of English comes back the same: the first stays.
    expect(chineseHearingWins(PART, PART)).toBe(false)
    expect(chineseHearingWins(EN, EN)).toBe(false)
  })
})

describe('transcribeAudio for a speaker who writes Chinese', () => {
  beforeEach(() => {
    calls.length = 0
    withContext = EN
    asChinese = ZH
    slowMs = 0
    plainFails = false
    _resetLanguageMemoryForTest()
    _setTitleTermsForTest(['Walnut'], Date.now(), true)
  })

  it('an English answer is heard again as Chinese, and its Chinese answer is the text', async () => {
    const r = await transcribeAudio(config, { audio: 'AAAA', format: 'wav', prompt: CONTEXT })
    expect(calls).toEqual(['auto', 'zh'])
    expect(r.text).toBe(ZH)
    expect(r.durationMs).toBe(70)
  })

  it('a take really spoken in English keeps its first answer', async () => {
    withContext = EN_REAL
    asChinese = 'So the interview is about payment and the system design round comes after lunch.'
    const r = await transcribeAudio(config, { audio: 'AAAA', format: 'wav', prompt: CONTEXT })
    expect(calls).toEqual(['auto', 'zh'])
    expect(r.text).toBe(EN_REAL)
    expect(r.durationMs).toBe(70)
  })

  it('a take translated in part is heard again as Chinese, and its Chinese answer is the text', async () => {
    withContext = PART
    const r = await transcribeAudio(config, { audio: 'AAAA', format: 'wav', prompt: CONTEXT })
    expect(calls).toEqual(['auto', 'zh'])
    expect(r.text).toBe(ZH)
  })

  it('previews of English speech are heard twice once a minute, never every tick; the final always is', async () => {
    withContext = EN_REAL
    asChinese = EN_REAL
    const preview = { audio: 'AAAA', format: 'wav', prompt: CONTEXT, preview: true }
    await transcribeAudio(config, preview)
    await transcribeAudio(config, preview)
    await transcribeAudio(config, preview)
    expect(calls).toEqual(['auto', 'zh', 'auto', 'auto'])
    calls.length = 0
    await transcribeAudio(config, { audio: 'AAAA', format: 'wav', prompt: CONTEXT })
    expect(calls).toEqual(['auto', 'zh'])
    calls.length = 0
    const later = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000)
    try {
      await transcribeAudio(config, preview)
      expect(calls).toEqual(['auto', 'zh'])
    } finally {
      later.mockRestore()
    }
  })

  it('a comparison hearing (Voice Accuracy) neither ends nor reads the live English-preview pause', async () => {
    // The user is speaking English: previews pause their second hearing.
    withContext = EN_REAL
    asChinese = EN_REAL
    const preview = { audio: 'AAAA', format: 'wav', prompt: CONTEXT, preview: true }
    await transcribeAudio(config, preview)
    calls.length = 0
    // A comparison of an old Chinese take, heard back as Chinese, would end that pause if it counted.
    withContext = EN
    asChinese = ZH
    const compared = await transcribeAudio(config, { audio: 'AAAA', format: 'wav', prompt: CONTEXT }, { comparison: true })
    expect(compared.text).toBe(ZH)
    expect(calls).toEqual(['auto', 'zh'])
    calls.length = 0
    // The live pause still stands: the next English preview is heard once.
    withContext = EN_REAL
    asChinese = EN_REAL
    await transcribeAudio(config, preview)
    expect(calls).toEqual(['auto'])
    // And a comparison flagged as a preview is never skipped by the live pause.
    calls.length = 0
    await transcribeAudio(config, preview, { comparison: true })
    expect(calls).toEqual(['auto', 'zh'])
  })

  it('a preview heard back as Chinese keeps every next preview checked', async () => {
    const preview = { audio: 'AAAA', format: 'wav', prompt: CONTEXT, preview: true }
    await transcribeAudio(config, preview)
    await transcribeAudio(config, preview)
    expect(calls).toEqual(['auto', 'zh', 'auto', 'zh'])
  })

  it('a long take whose first pass was slow is not heard twice', async () => {
    slowMs = 6000
    const r = await transcribeAudio(config, { audio: 'AAAA', format: 'wav', prompt: CONTEXT })
    expect(calls).toEqual(['auto'])
    expect(r.text).toBe(EN)
  })

  it('a failed second hearing keeps the first answer', async () => {
    plainFails = true
    const r = await transcribeAudio(config, { audio: 'AAAA', format: 'wav', prompt: CONTEXT })
    expect(calls).toEqual(['auto', 'zh'])
    expect(r.text).toBe(EN)
  })

  it('a Chinese answer costs one engine call', async () => {
    withContext = ZH
    const r = await transcribeAudio(config, { audio: 'AAAA', format: 'wav', prompt: CONTEXT })
    expect(calls).toEqual(['auto'])
    expect(r.text).toBe(ZH)
  })

  it('a language the caller chose is left alone', async () => {
    const r = await transcribeAudio(config, { audio: 'AAAA', format: 'wav', prompt: CONTEXT, language: 'en' })
    expect(calls).toEqual(['en'])
    expect(r.text).toBe(EN)
  })

  it('a speaker who writes no Chinese is never heard twice', async () => {
    _setTitleTermsForTest(['Walnut'], Date.now(), false)
    const r = await transcribeAudio(config, { audio: 'AAAA', format: 'wav', prompt: CONTEXT })
    expect(calls).toEqual(['auto'])
    expect(r.text).toBe(EN)
  })
})

describe('learned terms are words, never rewritten phrases', () => {
  it('termShaped keeps words and short names and drops phrases of common words', () => {
    for (const t of ['typo', 'cloud companion', 'T3 Code', 'Tailscale', 'Go']) expect(termShaped(t), t).toBe(true)
    for (const t of ['gor go it has to', 'it has to', 'one two three four']) expect(termShaped(t), t).toBe(false)
  })

  it('an edit that rewrote a span into a phrase teaches nothing', () => {
    // "slightly enough" in Chinese, rewritten by hand into an English phrase.
    const heard = '我们这个稍微够一下就好了吧'
    const sent = '我们这个 gor go it has to 一下就好了吧'
    expect(editPairs(heard, sent)).toEqual([])
  })
})

describe('which requests are previews', () => {
  it('the live draft route marks its requests as previews, and no other route does', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('../../src/web/routes/stt.ts', import.meta.url), 'utf8')
    const routes = src.split(/\nsttRouter\.(?=post|get)/).slice(1)
    const marked = routes.filter((r) => r.includes('preview: true')).map((r) => r.slice(0, r.indexOf(',')))
    expect(marked).toEqual(["post('/draft'"])
  })
})
