/**
 * Every letter Walnut writes itself is a kind in the letter registry
 * (src/core/human-inbox/walnut-letters/registry.ts; 2026-11-02, the user's org review: Walnut's own
 * letters must be written in his language, and the ones about a problem Walnut no longer raises
 * must settle themselves).
 *
 *   (a) every send site in src/ is a registered kind's caller, or listed exempt with why;
 *   (b) every kind renders in every letter language: the Chinese one in Chinese, the English one
 *       with no Han character, and the callers hold no Han text of their own;
 *   (c) every kind declares how Walnut knows it is no longer needed, or why it has no such rule.
 *
 * A new send site, a new kind without a language's text, or a kind without its rule fails here.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { EXEMPT_LETTER_SENDS, WALNUT_LETTER_KINDS } from '../../src/core/human-inbox/walnut-letters/registry.js'
import { LETTER_LANGUAGES, letterLanguageOf } from '../../src/core/human-inbox/walnut-letters/languages.js'
import { languageDrift, scriptCounts } from '../../src/core/hints/hint-drift-detect.js'

const ROOT = path.resolve(__dirname, '../..')

function sources(dir: string): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.posix.join(dir, e.name)
    if (e.isDirectory()) out.push(...sources(rel))
    else if (/\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(rel)
  }
  return out
}

/** Every way a letter is written: the store's writers, the session entry point, the plugin API. */
const SEND = /(?<![\w.])sendLetter(Once)?\s*\(|\bstore\.sendLetter(Once)?\s*\(|\bsendLetterAsCaller(Once)?\s*\(|\bletters\.send\s*\(/
const files = sources('src').map((f) => ({ f, text: fs.readFileSync(path.join(ROOT, f), 'utf8') }))
const sendSites = files.filter(({ text }) => SEND.test(text)).map(({ f }) => f).sort()
const callers = new Set(WALNUT_LETTER_KINDS.flatMap((k) => k.callers))
const han = (s: string) => scriptCounts(s).han

describe('(a) every letter send site is decided', () => {
  it('finds the send sites at all', () => {
    expect(sendSites).toEqual(expect.arrayContaining(['src/core/human-inbox/store.ts', 'src/core/hosts/host-exec.ts', 'src/core/plugins/server-api.ts']))
  })

  it('each one is a kind\'s caller or exempt with a reason', () => {
    const undecided = sendSites.filter((f) => !callers.has(f) && !(f in EXEMPT_LETTER_SENDS))
    expect(undecided, 'A new letter send: declare its kind in walnut-letters/registry.ts (words in every letter language), '
      + 'or list it in EXEMPT_LETTER_SENDS with why its words are not Walnut\'s').toEqual([])
    for (const [f, why] of Object.entries(EXEMPT_LETTER_SENDS)) expect(why.length, f).toBeGreaterThan(15)
    expect(sendSites.filter((f) => callers.has(f) && f in EXEMPT_LETTER_SENDS), 'a file is either a caller or exempt').toEqual([])
  })

  it('every listed caller exists and still sends', () => {
    for (const f of callers) expect(sendSites, `${f} is a kind's caller but sends no letter`).toContain(f)
  })

  it('kind ids are unique', () => {
    const ids = WALNUT_LETTER_KINDS.map((k) => k.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('(b) every kind renders in every letter language', () => {
  const CHINESE_RULE = 'Talk to the user in Chinese'
  for (const kind of WALNUT_LETTER_KINDS) {
    it(`${kind.id}: ${LETTER_LANGUAGES.join(', ')}`, () => {
      expect(kind.samples.length, 'give the ratchet sample params').toBeGreaterThan(0)
      for (const sample of kind.samples) {
        const en = kind.render('en', sample)
        const zh = kind.render('zh', sample)
        const enAll = [en.subject, en.markdown, ...(en.actions ?? []).flatMap((a) => [a.label, a.description ?? ''])].join('\n')
        expect(han(enAll), `${kind.id} English has Han text: ${enAll}`).toBe(0)
        expect(en.subject.trim()).not.toBe('')
        expect(han(zh.subject), `${kind.id} Chinese subject: ${zh.subject}`).toBeGreaterThan(0)
        expect(languageDrift(CHINESE_RULE, `${zh.subject}\n${zh.markdown}`, 8), `${kind.id} Chinese render is not Chinese:\n${zh.subject}\n${zh.markdown}`).toBe(false)
        if (zh.text !== undefined) expect(han(zh.text), `${kind.id} Chinese preview`).toBeGreaterThan(0)
        // Buttons: the same ids in every language, each label in that language.
        expect((zh.actions ?? []).map((a) => a.id)).toEqual((en.actions ?? []).map((a) => a.id))
        for (const a of zh.actions ?? []) expect(han(a.label), `${kind.id} button ${a.id}`).toBeGreaterThan(0)
      }
    })
  }

  it('the callers hold no Han text: the words live in the templates', () => {
    for (const f of callers) {
      const text = fs.readFileSync(path.join(ROOT, f), 'utf8')
      expect(han(text), `${f} has Han text; move it into its kind under walnut-letters/`).toBe(0)
    }
  })

  it('the letter language follows the reply-language rule, then the display language, else English', () => {
    expect(letterLanguageOf({ session: { reply_language: 'Talk to the user in Chinese; code stays English' } } as never)).toBe('zh')
    expect(letterLanguageOf({ session: { reply_language: '用中文回复' } } as never)).toBe('zh')
    expect(letterLanguageOf({ session: { reply_language: 'Answer in English' }, agent: { language: 'zh-CN' } } as never)).toBe('en')
    expect(letterLanguageOf({ session: { reply_language: 'Answer in French' } } as never)).toBe('en')
    expect(letterLanguageOf({ agent: { language: 'zh-Hans' } } as never)).toBe('zh')
    expect(letterLanguageOf({ agent: { language: 'ja' } } as never)).toBe('en')
    expect(letterLanguageOf({} as never)).toBe('en')
    expect(letterLanguageOf(null)).toBe('en')
  })
})

describe('(c) every kind says how Walnut knows it is no longer needed', () => {
  for (const kind of WALNUT_LETTER_KINDS) {
    it(kind.id, () => {
      const rule = kind.stillNeeded
      if ('check' in rule) {
        expect(typeof rule.check).toBe('function')
        // A rule the sweep cannot reach is no rule: the letter must be findable.
        expect(kind.marked || !!kind.matchesUnmarked, `${kind.id} has a check but no way to find its letters`).toBe(true)
      } else {
        expect(rule.none.length, `${kind.id}: say why it has no rule`).toBeGreaterThan(20)
      }
      // A decision waits on the user: without a check here it must name the file that closes it.
      if (kind.type === 'action_required' && 'none' in rule) expect(rule.none, `${kind.id}: name where it is settled`).toMatch(/\b[\w-]+\.ts\b/)
    })
  }
})

describe('Walnut\'s own words on a letter\'s record follow the letter language too', () => {
  // 2026-11-02 review: the reason a completion settles a decision letter, and the away thread's
  // "needs your answer" turn, were English for a user whose letters are Chinese.
  it('every phrase table has every letter language, and its Chinese is Chinese', async () => {
    const words = await import('../../src/core/human-inbox/walnut-letters/thread-words.js')
    const tables = Object.entries(words) as Array<[string, Record<string, (...a: string[]) => string>]>
    expect(tables.length).toBeGreaterThan(1)
    for (const [name, table] of tables) {
      expect(Object.keys(table).sort(), name).toEqual([...LETTER_LANGUAGES].sort())
      expect(languageDrift('Talk to the user in Chinese', table.zh!('Fix the build', '2026-11-02 05:00'), 8), name).toBe(false)
      expect(scriptCounts(table.en!('Fix the build', '2026-11-02 05:00')).han, name).toBe(0)
    }
  })
})
