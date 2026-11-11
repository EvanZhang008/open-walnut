/**
 * The phone's fold count follows the web's rule (tests/web/fold-failures.test.ts): "N failed" counts
 * failed calls only, so it never exceeds the calls the fold ran, and the runtime's error lines read
 * "N errors" apart (2026-11-09: a turn of 344 calls read "7859 failed" on the phone, because
 * `TimelineTurnShape.isFailure`, which is true for an error notice too, was counted).
 *
 * One place counts and words it, `TimelineFoldFailures` (ios-native/Walnut/Timeline/
 * TimelineFoldFailures.swift). Read from source: no other Swift file under ios-native/Walnut
 * counts a failure, hand-writes the "N failed" words, or carries a bare failure count, so a new
 * site that adds error lines to failed calls again fails here.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const IOS = path.resolve(import.meta.dirname, '../../ios-native/Walnut')
const SHARED = 'Timeline/TimelineFoldFailures.swift'

function swiftFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    return e.isDirectory() ? swiftFiles(p) : e.name.endsWith('.swift') ? [p] : []
  })
}

/** Source without `//` and `///` comments, so prose about the rule never trips it. */
const code = (src: string) => src.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n')

const files = swiftFiles(IOS)
  .map((file) => ({ rel: path.relative(IOS, file), src: code(fs.readFileSync(file, 'utf8')) }))
  .filter((f) => f.rel !== SHARED)

/** Every match of `re` in the non-shared sources, as `file:line: text`. */
function hits(re: RegExp, under = ''): string[] {
  return files.filter((f) => f.rel.startsWith(under)).flatMap(({ rel, src }) => [...src.matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'))]
    .map((m) => `${rel}:${src.slice(0, m.index).split('\n').length}: ${m[0].trim().slice(0, 120)}`))
}

describe('the iOS fold failure count has one rule', () => {
  const shared = fs.readFileSync(path.join(IOS, SHARED), 'utf8')

  it('the shared rule counts failed calls and error lines apart and words them like the web', () => {
    expect(shared).toMatch(/if isFailedCall\(m\) \{ out\.calls \+= 1 \} else if isErrorRow\(m\) \{ out\.errors \+= 1 \}/)
    expect(shared).toContain('parts.append("\\(calls) failed")')
    expect(shared).toContain('parts.append("\\(errors) \\(errors == 1 ? "error" : "errors")")')
    expect(shared).toContain('parts.joined(separator: " · ")')
  })

  it('isFailure (a failed call OR an error line) is never counted, only asked whether a turn is clean', () => {
    // Its definition and the one yes/no question it answers; any other use is a new count.
    const uses = hits(/[^\n]*\bisFailure\b[^\n]*/).map((h) => h.replace(/:\d+: /, ': '))
    expect(uses).toEqual([
      'Timeline/TimelineTurnShape.swift: static func isFailure(_ m: ChatMessage) -> Bool {',
      'Timeline/TimelineTurnShape.swift: if isFailure(m) { return false }',
    ])
  })

  it('no other file counts failed calls or error lines by hand', () => {
    expect(hits(/isError\s*==\s*true/)).toEqual([])
    expect(hits(/\.filter\s*\(\s*TimelineFoldFailures\.\w+\s*\)\s*\.count/)).toEqual([])
    expect(hits(/\.filter\s*\{[^}]*(isError|isErrorRow|isFailedCall)[^}]*\}\s*\.count/)).toEqual([])
    expect(hits(/count\s*\(\s*where:[^)]*(isError|isErrorRow|isFailedCall)/)).toEqual([])
    expect(hits(/(isErrorRow|isFailedCall)\([^)]*\)[^\n]*\+=\s*1/)).toEqual([])
  })

  it('no bare failure count and no hand-written "N failed" words outside the shared rule', () => {
    expect(hits(/\bfailCount\b/)).toEqual([])
    expect(hits(/\b(failed|fail)Count\s*:\s*Int\b/)).toEqual([])
    // A log line may say a step failed; a count of failures is worded only by the shared rule.
    expect(hits(/"\\\((?:\w+\.)*(?:count|calls|errors|failures|failed\w*|fail\w*)\) (?:failed|errors?)"/)).toEqual([])
  })

  it('every run and fold row carries the counted failures, and its badge reads their words', () => {
    const model = fs.readFileSync(path.join(IOS, 'Timeline/TimelineRowModel.swift'), 'utf8')
    expect(model).toMatch(/case toolRun\(phrase: String, failures: TimelineFoldFailures,/)
    expect(model).toMatch(/static func failedBadge\(_ failures: TimelineFoldFailures\) -> String \{\s*failures\.words\s*\}/)
    const builder = fs.readFileSync(path.join(IOS, 'Timeline/TimelineRowBuilder.swift'), 'utf8')
    expect(builder).toMatch(/func toolRunRow\([^)]*failures: TimelineFoldFailures,/)
    expect(builder).toMatch(/func foldRow\([^)]*failures: TimelineFoldFailures,/)
    const fold = fs.readFileSync(path.join(IOS, 'Timeline/TimelineTurnFold.swift'), 'utf8')
    expect(fold).toMatch(/let failures: TimelineFoldFailures\n/)
    // Every timeline place that fills one in counts with the shared rule, or says there are none
    // (a declaration names the type; a value is passed on, is none, or is counted here and now).
    // Other `failures:` names (a send queue's retries outside the timeline, an attachment
    // upload's per-file errors in it) are not fold counts.
    const fills = hits(/\bfailures:[ \t]*[^,)\n]+/, 'Timeline/')
      .filter((h) => !/^Timeline\/TimelineFileAttachment\.swift:\d+: failures: \[String: String\]/.test(h))
      .filter((h) => !/failures:\s*(TimelineFoldFailures\b(?![.(])|TimelineFoldFailures\.count\(|failures\b|fold\.failures\b|\.none\b)/.test(h))
    expect(fills).toEqual([])
    expect(hits(/failures:\s*TimelineFoldFailures\.count\(/).length).toBeGreaterThanOrEqual(3)
  })
})
