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
  it('every user kind has its label in every letter language', async () => {
    const { USER_KINDS } = await import('../../src/core/org/user-kind.js')
    const { USER_KIND_LABELS } = await import('../../src/core/human-inbox/walnut-letters/thread-words.js')
    for (const lang of LETTER_LANGUAGES) expect(Object.keys(USER_KIND_LABELS[lang]).sort(), lang).toEqual([...USER_KINDS].sort())
    for (const kind of USER_KINDS) {
      expect(han(USER_KIND_LABELS.zh[kind]), kind).toBeGreaterThan(1)
      expect(han(USER_KIND_LABELS.en[kind]), kind).toBe(0)
    }
  })

  it('every phrase table has every letter language, and its Chinese is Chinese', async () => {
    const words = await import('../../src/core/human-inbox/walnut-letters/thread-words.js')
    // The phrase functions (a label table such as USER_KIND_LABELS has its own test above).
    const tables = (Object.entries(words) as Array<[string, Record<string, unknown>]>)
      .filter(([, t]) => typeof t.en === 'function') as Array<[string, Record<string, (...a: string[]) => string>]>
    expect(tables.length).toBeGreaterThan(1)
    for (const [name, table] of tables) {
      expect(Object.keys(table).sort(), name).toEqual([...LETTER_LANGUAGES].sort())
      // Neutral arguments (a kind id, a time): only Walnut's own words decide the language.
      const args = ['cloud_delete', '2026-11-02 05:00']
      const zh = table.zh!(...args)
      expect(han(zh), `${name}: ${zh}`).toBeGreaterThan(0)
      expect(languageDrift('Talk to the user in Chinese', zh, 8), `${name}: ${zh}`).not.toBe(true)
      expect(scriptCounts(table.en!(...args)).han, name).toBe(0)
    }
  })
})

describe('(d) a kind Walnut stops sending is retired, and its open letters settle', () => {
  // Every kind id that was ever registered. Removing a kind from the registry without moving it to
  // RETIRED_LETTER_KINDS (retired.ts) fails here: its open letters would ask the user forever.
  const EVER_REGISTERED = [
    'host-sign-in', 'host-exec-ask', 'budget-paused', 'git-sync-secret-hold', 'git-sync-secret-aside', 'org-report',
    'mail-approval', 'mail-unsubscribe', 'mail-digest', 'offline-conflict', 'trigger-stopped',
  ]
  it('every kind ever registered is live or retired, and a new live kind is added to the list above', async () => {
    const { RETIRED_LETTER_KINDS } = await import('../../src/core/human-inbox/walnut-letters/retired.js')
    const live = WALNUT_LETTER_KINDS.map((k) => k.id)
    const retired = RETIRED_LETTER_KINDS.map((k) => k.id)
    expect(live.filter((id) => retired.includes(id))).toEqual([])
    for (const id of EVER_REGISTERED) expect(live.includes(id) || retired.includes(id), `${id} left the registry without being retired`).toBe(true)
    for (const id of [...live, ...retired]) expect(EVER_REGISTERED, `add ${id} to EVER_REGISTERED`).toContain(id)
  })

  it('each retired kind finds its old letters, never a live kind\'s or a session\'s, and says why in every language', async () => {
    const { RETIRED_LETTER_KINDS } = await import('../../src/core/human-inbox/walnut-letters/retired.js')
    const walnut = { sessionId: 'external', host: 'local' }
    for (const k of RETIRED_LETTER_KINDS) {
      expect(Object.keys(k.settleReason).sort(), k.id).toEqual([...LETTER_LANGUAGES].sort())
      expect(languageDrift('Talk to the user in Chinese', k.settleReason.zh, 8), k.id).toBe(false)
      expect(han(k.settleReason.en), k.id).toBe(0)
      expect(k.samples.length, k.id).toBeGreaterThan(0)
      for (const subject of k.samples) {
        expect(k.matches({ subject, sender: walnut } as never), `${k.id}: ${subject}`).toBe(true)
        expect(k.matches({ subject, sender: { sessionId: 's-1', host: 'local', taskId: 't-1' } } as never), `${k.id}: a session's letter`).toBe(false)
      }
      for (const live of WALNUT_LETTER_KINDS) {
        for (const sample of live.samples) {
          for (const lang of LETTER_LANGUAGES) {
            expect(k.matches({ subject: live.render(lang, sample).subject, sender: walnut } as never), `${k.id} would settle a live ${live.id} letter`).toBe(false)
          }
        }
      }
    }
  })
})

describe('(e) Walnut words written onto a letter come from the phrase tables', () => {
  // 2026-11-02 review: a Chinese decision letter opened with Walnut's English "Yours to decide
  // (...)" line. Words Walnut adds to a letter's body, thread or settled reason live in
  // walnut-letters/thread-words.ts (rendered per language above); these scans find a new place
  // that writes English of its own onto a letter instead.
  const outside = files.filter(({ f }) => !f.startsWith('src/core/human-inbox/walnut-letters/'))
  it('scans the source at all', () => expect(outside.length).toBeGreaterThan(500))
  /** An English word in a literal around a letter's text (a `Withdrawn: ` prefix is one). */
  const ENGLISH = /[A-Za-z]{4,}/
  /** English prose in an argument (two words; an id such as 'made_local' or 'string' is not). */
  const PROSE = /[A-Za-z][a-z]+[\s,:;]+[a-z]{2,}/
  const own = (lit: string) => lit.replace(/\$\{[^}]*\}/g, ' ')

  it('no settle or withdraw call passes a reason in its own words', () => {
    const CALL = /\b(settleLetter|settleLettersWhere|settleHoldLetter|withdrawLetter)\s*\(([^\n]*)/g // the rest of the call's line
    const hits: string[] = []
    for (const { f, text } of outside) {
      for (const m of text.matchAll(CALL)) {
        for (const lit of m[2]!.matchAll(/(['"`])((?:\\.|(?!\1).)*)\1/g)) {
          if (PROSE.test(own(lit[2]!))) hits.push(`${f}: ${m[0].slice(0, 140)}`)
        }
      }
    }
    expect(hits, 'put the words in walnut-letters/thread-words.ts and pass them in the letter language').toEqual([])
  })

  it('no code wraps words of its own around a letter body', () => {
    // A new body built from an existing one: `..${rest.markdown}`, `${input.text}` and the like.
    const WRAP = /`([^`]*)\$\{\s*(rest|input|letter|body)\.(markdown|html|text)\s*\}([^`]*)`/g
    const hits: string[] = []
    for (const { f, text } of outside) {
      for (const m of text.matchAll(WRAP)) if (ENGLISH.test(own(`${m[1]} ${m[4]}`))) hits.push(`${f}: ${m[0].slice(0, 140)}`)
    }
    expect(hits, 'put the words in walnut-letters/thread-words.ts').toEqual([])
  })

  it('a file that leads a letter body with Walnut words takes them from the tables', () => {
    const leaders = outside.filter(({ text }) => /`[^`]*\$\{\s*rest\.(markdown|html|text)\s*\}/.test(text)).map(({ f }) => f).sort()
    expect(leaders.length).toBeGreaterThan(0)
    for (const f of leaders) {
      const text = files.find((x) => x.f === f)!.text
      expect(text, `${f} wraps a letter body: its words must come from walnut-letters`).toMatch(/walnut-letters\/(thread-words|languages)\.js/)
    }
  })

  it('a thread turn Walnut writes onto a letter is not English of its own', () => {
    const PUSH = /thread\.push\(\s*\{[^}]*text:\s*(['"`])((?:\\.|(?!\1).)*)\1/g
    const hits: string[] = []
    for (const { f, text } of outside) {
      for (const m of text.matchAll(PUSH)) if (ENGLISH.test(own(m[2]!))) hits.push(`${f}: ${m[0].slice(0, 140)}`)
    }
    expect(hits).toEqual([])
  })
})
