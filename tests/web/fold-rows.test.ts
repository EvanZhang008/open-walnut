/**
 * The one fold rule (web/src/components/sessions/fold-rows.ts, iOS
 * TimelineTurnFold.isQuiet): every step of the work joins the stretch of quiet
 * steps around it, in every kind of turn; only a row the person reads ends one.
 *
 * 2026-10-30, the user's fourth report of the same split: each earlier fix folded
 * one more row kind and left the rest, so a failed command and the runtime's error
 * lines still cut one stretch into three rows. The guards below read the row kinds
 * from the source (the timeline's part union, the history's system variants, the
 * fold line's step kinds, the phone's message kinds) and fail when a new one
 * appears that the rule does not place. The rendered rows are pinned by
 * tests/e2e/browser/session-fold-one-rule.spec.ts.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  joinsQuiet, MSG_KIND_ROLE, SYSTEM_VARIANT_ROLE, toolRole, TOOL_ROLE_FOLDS, type PlaceRead,
} from '../../web/src/components/sessions/fold-rows'
import { foldStepsPhrase } from '../../web/src/components/sessions/fold-steps'

const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8')
const HISTORY = read('web/src/components/sessions/SessionChatHistory.tsx')
const sorted = (xs: Iterable<string>) => [...new Set(xs)].sort()

/** The body of a TS arrow `const name = (…) … => {…};` (to its first line that closes at column 2). */
function arrowBody(src: string, name: string): string {
  const start = src.indexOf(`const ${name} = (`)
  expect(start, name).toBeGreaterThanOrEqual(0)
  const end = src.indexOf('\n  };', start)
  return src.slice(start, end)
}

describe('every row kind is placed by the rule', () => {
  it('the timeline\'s part kinds: each one is a case of the row classifier', () => {
    const from = HISTORY.indexOf('type HistoryPart =')
    // The union runs to the first line that starts at column 0 after its own.
    const rest = HISTORY.slice(from + 1)
    const union = HISTORY.slice(from, from + 1 + rest.search(/\n[^\s|]/))
    const kinds = [...union.matchAll(/[=|]\s*\{\s*kind:\s*'([\w-]+)'/g)].map((m) => m[1])
    expect(kinds).toContain('msg')
    expect(kinds).toContain('system-run')
    const cases = [...arrowBody(HISTORY, 'msgKindOf').matchAll(/case '([\w-]+)':/g)].map((m) => m[1])
    expect(sorted(cases)).toEqual(sorted(kinds))
    expect(arrowBody(HISTORY, 'msgKindOf')).toContain('const unplaced: never = part')
  })

  it('every system variant a history row carries (server and web types)', () => {
    const variants: string[] = []
    for (const p of ['src/core/session-history.ts', 'web/src/types/session.ts']) {
      for (const m of read(p).matchAll(/systemVariant\?:\s*([^;\n]+)/g)) variants.push(...[...m[1].matchAll(/'(\w+)'/g)].map((x) => x[1]))
    }
    expect(variants.length).toBeGreaterThan(0)
    expect(sorted([...variants, 'none'])).toEqual(sorted(Object.keys(SYSTEM_VARIANT_ROLE)))
    // The table is what runs: a system row's role is read from it.
    expect(arrowBody(HISTORY, 'rowRoleOf')).toContain("SYSTEM_VARIANT_ROLE[m.systemVariant ?? 'none']")
  })

  it('the row classifier answers only with kinds the rule has, and every one of them', () => {
    const body = arrowBody(HISTORY, 'msgKindOf')
    const returned = [...body.matchAll(/'(\w+)'/g)].map((m) => m[1]).filter((k) => k in MSG_KIND_ROLE)
    expect(sorted(returned)).toEqual(sorted(Object.keys(MSG_KIND_ROLE)))
    // Every part kind reaches it: the system run by name, the rest by content.
    expect(body).toContain("case 'system-run'")
  })

  it('a row the classifier tells by its content is a step, and the fold line says what it was', () => {
    // A new content test that answered 'other' would end a stretch again (review,
    // 2026-10-30): every `if (isXPart(part)) return '<kind>'` answers a step.
    const body = arrowBody(HISTORY, 'msgKindOf')
    const tests = [...body.matchAll(/if \((is\w+Part)\(part\)\) return '(\w+)'/g)].map((m) => ({ fn: m[1], kind: m[2] }))
    expect(tests.length).toBeGreaterThanOrEqual(4)
    const steps = arrowBody(HISTORY, 'foldStepsOf')
    for (const { fn, kind } of tests) {
      expect(MSG_KIND_ROLE[kind as keyof typeof MSG_KIND_ROLE], `${fn} -> ${kind}`).toBe('step')
      // ...and its fold step comes from the same test (isContextPart's twin is contextKindOf).
      const twin = fn.replace(/^is(\w)(\w*)Part$/, (_, a: string, b: string) => `${a.toLowerCase()}${b}KindOf`)
      expect(steps.includes(`${fn}(part)`) || steps.includes(`${twin}(part)`), `foldStepsOf reads ${fn}`).toBe(true)
    }
  })

  it('a row\'s role in a turn comes from the rule alone (no per-kind exceptions in place())', () => {
    const place = arrowBody(HISTORY, 'place')
    expect(place).toContain('joinsQuiet(')
    expect(place).not.toMatch(/kind === 'open'/)
    // The old exclusion that split the reported stretch: a failed call ended it.
    expect(arrowBody(HISTORY, 'readProcessTools')).not.toMatch(/isError/)
  })

  it('every fold step kind is counted or named on the fold line (web and iOS)', () => {
    const steps = read('web/src/components/sessions/fold-steps.ts')
    const union = steps.slice(steps.indexOf('export type FoldStep ='), steps.indexOf('export function envelopeSteps'))
    const kinds = [...union.matchAll(/kind:\s*'(\w+)'/g)].map((m) => m[1])
    const phrase = steps.slice(steps.indexOf('export function foldStepsPhrase'))
    // `thought` and `context` are counted by nothing on purpose (the empty line is "Thinking").
    for (const k of kinds.filter((k) => k !== 'thought' && k !== 'context')) expect(phrase, k).toContain(`s.kind === '${k}'`)
    const ios = read('ios-native/Walnut/Timeline/TimelineFoldSteps.swift')
    const iosKinds = [...ios.slice(ios.indexOf('enum Step'), ios.indexOf('static func steps')).matchAll(/^\s*case (\w+)/gm)].map((m) => m[1])
    const iosPhrase = ios.slice(ios.indexOf('static func phrase'))
    for (const k of iosKinds) expect(iosPhrase, `iOS .${k}`).toMatch(new RegExp(`\\.${k}\\b`))
    expect(sorted(iosKinds)).toEqual(sorted(kinds.map((k) => (k === 'calls' ? 'calls' : k))))
  })

  it('the phone names every message kind in its quiet test', () => {
    const models = read('ios-native/Walnut/API/Models.swift')
    const kindEnum = models.slice(models.indexOf('enum Kind: String, Codable {'), models.indexOf('let id: String', models.indexOf('enum Kind: String, Codable {')))
    const kinds = [...kindEnum.matchAll(/^\s*case (\w+)/gm)].map((m) => m[1])
    expect(kinds.length).toBeGreaterThan(0)
    const fold = read('ios-native/Walnut/Timeline/TimelineTurnFold.swift')
    const isQuiet = fold.slice(fold.indexOf('private static func isQuiet'), fold.indexOf('private func member'))
    for (const k of kinds) expect(isQuiet, `.${k}`).toMatch(new RegExp(`\\.${k}\\b`))
    expect(isQuiet).toContain('case nil')
    // A failed call is a step on the phone too.
    const finished = fold.slice(fold.indexOf('private static func isFinishedStep'), fold.indexOf('private static func rows'))
    expect(finished).not.toContain('isFailure')
  })
})

describe('the rule', () => {
  const foldable = (t: { name: string }) => t.name !== 'ExitPlanMode'
  it('a failed call is a step; a question, a running call and a card are not', () => {
    expect(toolRole({ name: 'Bash', result: 'Error: exit 1', isError: true }, foldable)).toBe('step')
    expect(toolRole({ name: 'Bash', result: 'ok' }, foldable)).toBe('step')
    expect(toolRole({ name: 'AskUserQuestion', result: 'A' }, foldable)).toBe('question')
    expect(toolRole({ name: 'Bash' }, foldable)).toBe('running')
    expect(toolRole({ name: 'ExitPlanMode', result: 'ok' }, foldable)).toBe('card')
    expect(Object.entries(TOOL_ROLE_FOLDS).filter(([, v]) => v).map(([k]) => k)).toEqual(['step'])
  })

  const base: PlaceRead = { role: 'step', turn: 'open', personStart: false, labelled: false, beforeAnswer: false }
  it('a step joins the stretch in every turn kind, before or after an answer', () => {
    for (const turn of ['open', 'answered', 'hidden', null] as const) {
      for (const beforeAnswer of [false, true]) expect(joinsQuiet({ ...base, turn, beforeAnswer }), `${turn} ${beforeAnswer}`).toBe(true)
    }
  })
  it('a row the person reads ends it, except what a turn\'s shape folds', () => {
    expect(joinsQuiet({ ...base, role: 'reads' })).toBe(false)
    expect(joinsQuiet({ ...base, role: 'reads', turn: 'answered' })).toBe(false)
    expect(joinsQuiet({ ...base, role: 'reads', turn: 'answered', beforeAnswer: true })).toBe(true)
    expect(joinsQuiet({ ...base, role: 'reads', turn: 'hidden' })).toBe(true)
    expect(joinsQuiet({ ...base, personStart: true, turn: 'hidden' })).toBe(false)
    expect(joinsQuiet({ ...base, labelled: true })).toBe(false)
  })

  it('the reported stretch reads as one line', () => {
    const phrase = foldStepsPhrase([
      { kind: 'received', from: 'notification' },
      ...Array.from({ length: 4 }, () => ({ kind: 'calls' as const, tools: [{ name: 'Bash' }] })),
      { kind: 'ack' },
      { kind: 'received', from: 'trigger' },
      ...Array.from({ length: 20 }, () => ({ kind: 'notice' as const, error: true })),
      { kind: 'calls', tools: [{ name: 'Bash' }] },
    ])
    expect(phrase).toBe('Received 2 messages · Ran 5 tools')
    // Error lines are the red count; the runtime's other lines are named.
    expect(foldStepsPhrase([{ kind: 'notice', error: true }, { kind: 'notice', error: true }])).toBe('2 notices')
    expect(foldStepsPhrase([{ kind: 'calls', tools: [{ name: 'Bash' }] }, { kind: 'notice' }])).toBe('Ran 1 tool · 1 notice')
  })
})
