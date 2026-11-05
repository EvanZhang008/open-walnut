/**
 * Whose words a hint is (src/core/hints/hint-origin.ts; 2026-11-01, the user: "it
 * should be clear which is built in which is user defined"). The class guard: every
 * built-in is rendered from a config whose every session setting is a marker, in
 * every state the registry reads; a marker may only ever sit in a part marked as the
 * user's, and Walnut's own parts never hold one. A new built-in that sends a setting
 * of the user's without HINT_USER_SETTINGS saying so fails here, and so does a new
 * built-in missing from BUILT_IN_HINT_KINDS.
 */
import { describe, it, expect } from 'vitest'
import { effectiveHints, HINT_TRIGGERS, describeHint } from '../../../src/core/hints/hint-registry.js'
import {
  BUILT_IN_HINT_KINDS, REPLY_LANGUAGE_SCOPE, hintTextParts, replyLanguageCorrection,
} from '../../../src/core/hints/hint-origin.js'
import type { MessageHintTrigger } from '../../../src/core/types.js'

const MARK = 'ZQMARK'

/** A config whose every session setting a hint could read is a marker string. */
const markedConfig = {
  session: new Proxy({}, {
    get: (_t, k) => (k === 'hints' || typeof k === 'symbol' ? undefined : `${MARK}_${String(k)} words`),
  }),
} as never

function reasonSets(): Array<Set<MessageHintTrigger>> {
  return [...HINT_TRIGGERS.map((t) => new Set([t])), new Set(HINT_TRIGGERS)]
}

describe('hint origin', () => {
  it('names every built-in of the registry', () => {
    expect(effectiveHints(null).filter((h) => h.builtIn).map((h) => h.kind)).toEqual([...BUILT_IN_HINT_KINDS])
  })

  it("a user's setting in a built-in's text is always marked as theirs, Walnut's words never", () => {
    const inputs = [
      { config: markedConfig, record: null },
      { config: markedConfig, record: { hintState: { drift: { 'reply-language': '2026-11-01T08:00:00.000Z' } } } },
      { config: markedConfig, record: null, request: { arg: '7' }, toldHash: 'rich' },
      { config: markedConfig, record: { output_mode: 'markdown' as const }, toldHash: 'rich' },
      { config: markedConfig, record: null, away: { away: true, lastSeenAt: Date.UTC(2026, 10, 1) } },
      { config: markedConfig, record: null, away: { away: false, lastSeenAt: null }, toldHash: 'away' },
      { config: markedConfig, record: null, brief: { at: null, stale: true, words: 'two lines moved', key: 'k' } },
      { config: markedConfig, record: null, thread: { threadId: 'th-1', title: 'Fix the hints', created: true, followUp: false, duplicate: false, open: [{ id: 'th-2', title: 'Other', state: 'open' as never }], closed: [] } },
    ]
    // A rule naming a non-Latin language, under a message in another: Walnut adds no words of its own for it.
    const zhConfig = { session: { reply_language: `${MARK} Talk to the user in Chinese.` } } as never
    inputs.push(
      { config: zhConfig, record: null, message: "chinse, I don't know what happened" } as never,
      { config: zhConfig, record: { hintState: { drift: { 'reply-language': '2026-11-01T08:00:00.000Z' } } }, message: 'why is this project not local by default?' } as never,
    )
    let sawUser = 0
    for (const hint of effectiveHints(markedConfig).filter((h) => h.builtIn)) {
      for (const input of inputs) {
        for (const reasons of reasonSets()) {
          const out = hint.render(input, reasons)
          if (!out) continue
          const parts = hintTextParts({ kind: hint.kind, text: out.text.trim() })
          for (const p of parts) {
            if (p.from === 'walnut') expect(p.text, `${hint.kind}: Walnut's part holds a setting`).not.toContain(MARK)
            else { expect(p.text, `${hint.kind}: a user part with no setting in it`).toContain(MARK); sawUser++ }
          }
          expect(parts.map((p) => p.text).join(' ')).toBe(out.text.trim())
        }
      }
    }
    expect(sawUser).toBeGreaterThan(0)
  })

  it('cuts the Reply language hint into Walnut, the user, Walnut', () => {
    const rule = 'Talk to the user in Chinese; code stays English.'
    expect(hintTextParts({ kind: 'reply-language', text: `${rule} ${REPLY_LANGUAGE_SCOPE}` })).toEqual([
      { text: rule, from: 'user', setting: 'Reply language' },
      { text: REPLY_LANGUAGE_SCOPE, from: 'walnut' },
    ])
    const fix = replyLanguageCorrection('2026-11-01T08:00:00.000Z')
    expect(hintTextParts({ kind: 'reply-language', text: `${fix} ${rule} ${REPLY_LANGUAGE_SCOPE}` }).map((p) => p.from))
      .toEqual(['walnut', 'user', 'walnut'])
    // 2026-11-05: Walnut writes no lines of its own in the user's language. Under an English
    // message to a rule naming Chinese, the rendered hint is the rule and the scope, and a
    // correction (on_drift) is Walnut's English sentence in front of them.
    const zhRule = 'Talk to the user in Chinese.'
    const hint = effectiveHints({ session: { reply_language: zhRule } } as never).find((h) => h.kind === 'reply-language')!
    const plain = hint.render({ config: { session: { reply_language: zhRule } }, record: null, message: 'why is this not local?' } as never, new Set(['on_change']))!
    expect(plain.text).toBe(`${zhRule} ${REPLY_LANGUAGE_SCOPE}`)
    const driftAt = '2026-11-01T08:00:00.000Z'
    const drifted = hint.render({ config: { session: { reply_language: zhRule } }, record: { hintState: { drift: { 'reply-language': driftAt } } }, message: 'why is this not local?' } as never, new Set(['on_drift']))!
    expect(drifted.text).toBe(`${replyLanguageCorrection(driftAt)} ${zhRule} ${REPLY_LANGUAGE_SCOPE}`)
    expect(drifted.text).toMatch(/^[\x00-\x7f]*$/)
    expect(hintTextParts({ kind: 'reply-language', text: drifted.text })).toEqual([
      { text: replyLanguageCorrection(driftAt), from: 'walnut' },
      { text: zhRule, from: 'user', setting: 'Reply language' },
      { text: REPLY_LANGUAGE_SCOPE, from: 'walnut' },
    ])
    // An old message from before the scope clause: all of it was the setting.
    expect(hintTextParts({ kind: 'reply-language', text: rule })).toEqual([{ text: rule, from: 'user', setting: 'Reply language' }])
  })

  it("a custom hint is all the user's; a built-in with no setting all Walnut's", () => {
    expect(hintTextParts({ kind: 'tone', text: 'Keep it short.' })).toEqual([{ text: 'Keep it short.', from: 'user' }])
    expect(hintTextParts({ kind: 'rich-output', text: 'rich output mode is still on.' })).toEqual([{ text: 'rich output mode is still on.', from: 'walnut' }])
    expect(hintTextParts({ kind: 'session-context', text: 'x' })).toEqual([{ text: 'x', from: 'walnut' }])
  })

  it("Settings reads each row's origin and the setting a built-in sends", () => {
    const config = { session: { reply_language: 'Answer in French.', hints: { tone: { text: 'Keep it short.' }, 'rich-output': { every_turns: 3 } } } } as never
    const rows = effectiveHints(config).map((h) => describeHint(h, config))
    const by = (k: string) => rows.find((r) => r.kind === k)!
    expect(by('tone')).toMatchObject({ built_in: false })
    expect(by('rich-output')).toMatchObject({ built_in: true, overridden: true })
    expect(by('rich-output')).not.toHaveProperty('user_setting')
    expect(by('reply-language').user_setting).toEqual({
      label: 'Reply language', anchor: 'session-reply-language', value: 'Answer in French.', walnut_text: REPLY_LANGUAGE_SCOPE,
    })
    expect(describeHint(effectiveHints(null).find((h) => h.kind === 'reply-language')!, null).user_setting?.value).toBeNull()
  })
})

describe("Walnut's own names", () => {
  it('a custom hint cannot take the name of Walnut text outside the registry', async () => {
    const { validateHintSettings } = await import('../../../src/core/hints/hint-registry.js')
    for (const kind of ['session-context', 'engine-switch']) {
      expect(() => validateHintSettings(kind, { text: 'mine' })).toThrow(/Walnut's own text/)
      const config = { session: { hints: { [kind]: { text: 'mine' } } } } as never
      expect(effectiveHints(config).map((h) => h.kind)).not.toContain(kind)
    }
  })

  it('Settings shows the reply language as it is sent', () => {
    const config = { session: { reply_language: '  Answer\n in   French.  ' } } as never
    const row = describeHint(effectiveHints(config).find((h) => h.kind === 'reply-language')!, config)
    expect(row.user_setting?.value).toBe('Answer in French.')
  })
})
