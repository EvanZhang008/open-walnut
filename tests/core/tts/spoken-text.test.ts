/**
 * What voice mode reads aloud (src/core/tts/spoken-text.ts): the server's copy of
 * the phone's SpokenText rules, so the web and the phone say the same words.
 * Non-ASCII test data is written with \u escapes (repo language rule).
 */
import { describe, expect, it } from 'vitest'
import { chunksOf, estimatedSeconds, languageOf, plain, prepareSpokenText, REST_ON_SCREEN, sentences, shortenPaths, spokenPart } from '../../../src/core/tts/spoken-text.js'

// "Done, all tests passed." / "Details are on screen." in Chinese.
const ZH_DONE = '\u597d\u7684\uff0c\u6d4b\u8bd5\u90fd\u901a\u8fc7\u4e86\u3002'
const ZH_DETAIL = '\u8be6\u60c5\u5728\u5c4f\u5e55\u4e0a\u3002'

describe('spoken part', () => {
  it('reads only what comes before a line holding only ---', () => {
    const r = prepareSpokenText(`I fixed the login bug and the tests pass.\n\n---\n\n## Detail\n\n\`\`\`ts\nconst x = 1\n\`\`\``)!
    // The spoken answer is whole: the session itself says the details are on screen.
    expect(r.text).toBe('I fixed the login bug and the tests pass.')
    expect(r.truncated).toBe(true)
  })

  it('a reply that opens with a rule is read whole, never silent', () => {
    expect(spokenPart('---\nHello there.').head).toBe('---\nHello there.')
  })

  it('a rule with nothing after it cuts nothing', () => {
    expect(spokenPart('Hello.\n---\n  ').cutAtRule).toBe(false)
  })
})

describe('markdown to sentences', () => {
  it('drops code blocks, tables, images and bare URLs; keeps link words and inline code text', () => {
    const md = [
      '# Result',
      'See [the PR](https://example.com/pr/1) and https://example.com/x for `npm test`.',
      '| a | b |',
      '|---|---|',
      '| 1 | 2 |',
      '![shot](/tmp/a.png)',
      '```bash\nrm -rf /\n```',
      '- **First** item',
      '- second item',
    ].join('\n')
    expect(plain(md)).toBe('Result. See the PR and for npm test. First item. second item.')
  })

  it('shortens paths to their last part, leaves and/or alone', () => {
    expect(shortenPaths('open /Users/me/repo/src/Foo.swift and src/bar.ts and/or that')).toBe('open Foo.swift and bar.ts and/or that')
  })

  it('ends a Chinese line with the ideographic full stop', () => {
    expect(plain('\u6d4b\u8bd5\u901a\u8fc7')).toBe('\u6d4b\u8bd5\u901a\u8fc7\u3002')
  })

  it('a reply that is only code has nothing to say', () => {
    expect(prepareSpokenText('```\ncode\n```')).toBeNull()
    expect(prepareSpokenText('')).toBeNull()
  })
})

describe('language', () => {
  it('Chinese with English words mixed in is Chinese', () => {
    // "I looked at the CI on GitHub, build is green" with English words.
    expect(languageOf('\u6211\u521a\u770b\u4e86 GitHub \u4e0a\u7684 CI\uff0cbuild \u662f\u7eff\u7684')).toBe('zh-CN')
  })
  it('English is English; kana is Japanese', () => {
    expect(languageOf('All tests passed.')).toBe('en-US')
    expect(languageOf('\u3053\u3093\u306b\u3061\u306f')).toBe('ja-JP')
  })
})

describe('length budget', () => {
  it('cuts at a sentence end and says the rest is on screen', () => {
    const long = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} is here.`).join(' ')
    const r = prepareSpokenText(long)!
    expect(r.truncated).toBe(true)
    expect(r.text.endsWith(REST_ON_SCREEN)).toBe(true)
    expect(estimatedSeconds(r.text)).toBeLessThanOrEqual(42)
    expect(r.text).toMatch(/here\. The rest is on screen\.$/)
  })

  it('a short reply is whole and not truncated', () => {
    const r = prepareSpokenText(`${ZH_DONE}${ZH_DETAIL}`)!
    expect(r.truncated).toBe(false)
    expect(r.language).toBe('zh-CN')
    expect(r.text).toBe(`${ZH_DONE}${ZH_DETAIL}`)
  })
})

describe('pieces', () => {
  it('the first sentence is a piece of its own, so the voice starts soon', () => {
    const chunks = chunksOf('Done. I moved the task to a new session. All tests passed. The details are on screen.')
    expect(chunks[0]).toBe('Done.')
    expect(chunks.join(' ')).toBe('Done. I moved the task to a new session. All tests passed. The details are on screen.')
    expect(chunks.length).toBeLessThanOrEqual(3)
  })

  it('Chinese pieces join without a space', () => {
    const chunks = chunksOf(`${ZH_DONE}${ZH_DETAIL}${ZH_DONE}`)
    expect(chunks.join('')).toBe(`${ZH_DONE}${ZH_DETAIL}${ZH_DONE}`)
  })

  it('a decimal is not a sentence end', () => {
    expect(sentences('Version 2.5 is out. Try it.')).toEqual(['Version 2.5 is out.', ' Try it.'])
  })

  it('a very long sentence is cut at a comma', () => {
    const clause = 'and then we looked at the next part of the list'
    const chunks = chunksOf(`${Array.from({ length: 6 }, () => clause).join(', ')}.`)
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks.slice(0, -1)) expect(c.endsWith(',')).toBe(true)
  })
})
