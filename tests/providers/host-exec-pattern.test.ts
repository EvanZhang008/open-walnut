/**
 * wait_for's rules (src/providers/host-exec-pattern.ts): what a wait_for may say. Patterns run in
 * the killable matcher, so the check refuses only the textbook exponential shapes and accepts
 * the ordinary patterns a dev server or a test runner calls for (2026-11-04 real-use review: a
 * cost check refused `ready in \d+(\.\d+)? ?ms`, `Local:\s+http://\S+:(\d+)` and an IPv4
 * address). Matching is per line, so the m and s flags and a line break in the pattern are
 * refused with that reason; `flags: "i"` and a leading `(?i)` ignore case.
 *
 * MACHINE SAFETY: pure functions, no process, file or network (one test reads this module's source text).
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { WAIT_PATTERN_MAX, cutPattern, exponentialShape, linePattern, parseWaitFor } from '../../src/providers/host-exec-pattern.js'

describe('parseWaitFor', () => {
  it('takes output, flags, partial, port and file', () => {
    const p = parseWaitFor({ output: '^ready$', flags: 'i', partial: true, port: 5173, file: ' dist/index.html ' })
    expect(p).toMatchObject({ ok: true, waitFor: { output: '^ready$', flags: 'i', partial: true, port: 5173, file: 'dist/index.html' } })
    expect(p.ok && p.pattern).toEqual({ source: '^ready$', flags: 'is', cut: '^ready(?!)', resume: { source: '^ready$', cut: '^ready(?!)' } })
    // No flag unless asked (s only: `.` matches any character of a line): a line is matched case by case.
    expect(parseWaitFor({ output: 'Ready' })).toMatchObject({ ok: true, pattern: { flags: 's' } })
  })

  it('a leading (?i), as other regex flavours write it, is the i flag', () => {
    // 2026-11-04 real-use review: `(?i)` was refused while `(?i:...)` worked, which an agent had to guess.
    const p = parseWaitFor({ output: '(?i)server ready' })
    expect(p).toMatchObject({ ok: true, waitFor: { output: 'server ready', flags: 'i' }, pattern: { source: 'server ready', flags: 'is' } })
    expect(p.ok && new RegExp(p.pattern!.source, p.pattern!.flags).test('SERVER READY')).toBe(true)
    expect(parseWaitFor({ output: '(?i:server) ready' })).toMatchObject({ ok: true, pattern: { flags: 's' } })
  })

  it('a pattern written as a JavaScript literal, /body/flags, is read as its body with those flags, and says so', () => {
    // 2026-11-04 real-use review: `/ready/i` was taken as the text "/ready/i" and never matched "ready", with no word.
    const p = parseWaitFor({ output: '/ready/i' })
    expect(p).toMatchObject({ ok: true, waitFor: { output: 'ready', flags: 'i' }, pattern: { source: 'ready', flags: 'is' } })
    expect(p.ok && p.read).toBe('wait_for.output "/ready/i" is written as a JavaScript regex literal, so it was read as /ready/ with the flags i')
    expect(parseWaitFor({ output: '/\\p{Lu}+ ready/u' })).toMatchObject({ ok: true, waitFor: { flags: 'u' }, pattern: { flags: 'su' } })
    expect(parseWaitFor({ output: '/x/iu', flags: 'i' })).toMatchObject({ ok: true, waitFor: { output: 'x', flags: 'iu' } })
    // y holds a match to the line's start: an anchor, so no state rides from one line to the next.
    const y = parseWaitFor({ output: '/ready|up/y' })
    expect(y).toMatchObject({ ok: true, waitFor: { output: '^(?:ready|up)' } })
    const re = y.ok ? new RegExp(y.pattern!.source, y.pattern!.flags) : null
    expect([re!.test('ready now'), re!.test('now up'), re!.test('up')]).toEqual([true, false, true])
    // No flags: an ordinary pattern for the text; nor an escaped closing slash, nor a repeated flag.
    for (const plain of ['/tmp/', '/a\\/i', '/x/ii', 'ready/i']) {
      expect(parseWaitFor({ output: plain })).toMatchObject({ ok: true, waitFor: { output: plain } })
      expect((parseWaitFor({ output: plain }) as { read?: string }).read).toBeUndefined()
    }
    // What the server sends is read the same way by the daemon (it parses it again).
    for (const given of ['/ready/i', '//x/i/i', '/(?i)Up/y', '(?i)/x/i', '(?i)/usr/bin/s']) {
      const first = parseWaitFor({ output: given })
      if (!first.ok) throw new Error(first.error)
      const again = parseWaitFor(first.waitFor)
      expect(again).toMatchObject({ ok: true, waitFor: first.waitFor, pattern: first.pattern })
      expect((again as { read?: string }).read).toBeUndefined()
    }
  })

  it('a literal with g or d is read without them, and says so; v is refused with its reason', () => {
    // 2026-11-04 review: `/ready/g` and `/ready/gi` were taken as the text "/ready/g", which never comes.
    const g = parseWaitFor({ output: '/ready/g' })
    expect(g).toMatchObject({ ok: true, waitFor: { output: 'ready' }, pattern: { source: 'ready', flags: 's' } })
    expect(g.ok && g.waitFor.flags).toBeUndefined()
    expect(g.ok && g.read).toBe('wait_for.output "/ready/g" is written as a JavaScript regex literal, so it was read as /ready/ (g dropped: each line is tested on its own, once)')
    const gi = parseWaitFor({ output: '/ready/gi' })
    expect(gi).toMatchObject({ ok: true, waitFor: { output: 'ready', flags: 'i' } })
    expect(gi.ok && gi.read).toBe('wait_for.output "/ready/gi" is written as a JavaScript regex literal, so it was read as /ready/ with the flags i (g dropped: each line is tested on its own, once)')
    const d = parseWaitFor({ output: '/(\\d+) passed/dg' })
    expect(d).toMatchObject({ ok: true, waitFor: { output: '(\\d+) passed' } })
    expect(d.ok && d.read).toContain('(d and g dropped: each line is tested on its own, once, and the match is the whole line)')
    // Read the same way again by the daemon.
    for (const given of ['/ready/g', '/ready/gi', '//x/g/g']) {
      const first = parseWaitFor({ output: given })
      if (!first.ok) throw new Error(first.error)
      expect(parseWaitFor(first.waitFor)).toMatchObject({ ok: true, waitFor: first.waitFor, pattern: first.pattern })
    }
    expect(parseWaitFor({ output: '/[\\p{L}--[a-z]]/v' })).toMatchObject({ ok: false, error: expect.stringMatching(/the v flag .*use "u"/) })
    expect(parseWaitFor({ output: '/x/gm' })).toMatchObject({ ok: false, error: expect.stringContaining('m and s flags change nothing') })
  })

  it.each([
    [undefined, /must be an object/],
    ['ready', /must be an object/],
    [{}, /needs output, port or file/],
    [{ output: '' }, /non-empty/],
    [{ output: '(?i)' }, /non-empty/],
    [{ output: '(unclosed' }, /not a valid regular expression/],
    [{ output: 'a'.repeat(WAIT_PATTERN_MAX + 1) }, /too long/],
    [{ output: '(a+)+$' }, /could take too long to run.*Match a plainer piece of the line/],
    [{ output: 'x', flags: 'm' }, /each line is matched on its own, so the m and s flags change nothing/],
    [{ output: 'x', flags: 'is' }, /m and s flags/],
    [{ output: 'x', flags: 'g' }, /wait_for takes "i" \(case-insensitive\) and "u" \(Unicode\) only/],
    [{ output: '/x/m' }, /regex literal with the flags "m".*m and s flags change nothing/],
    [{ output: '/x/is' }, /m and s flags/],
    [{ output: `/${'a'.repeat(196)}/y` }, /too long/],
    [{ output: 'x', flags: 'I' }, /takes lowercase letters/],
    [{ flags: 'i', port: 80 }, /flags goes with wait_for.output/],
    [{ partial: true, port: 80 }, /partial goes with wait_for.output/],
    [{ output: 'x', partial: 'yes' }, /partial must be true or false/],
    [{ output: 'one\\ntwo' }, /has a line break in it, but each line is matched on its own/],
    [{ output: 'one\ntwo' }, /line break/],
    [{ output: 'done\\r' }, /line break/],
    [{ port: 0 }, /TCP port/],
    [{ port: 70000 }, /TCP port/],
    [{ port: 80.5 }, /TCP port/],
    [{ file: '  ' }, /must be a path/],
    [{ output: 'x', outptu: 'y' }, /not outptu/],
  ])('refuses %j', (raw, why) => {
    const p = parseWaitFor(raw)
    expect(p.ok).toBe(false)
    expect(!p.ok && p.error).toMatch(why)
  })

  // 2026-11-04 review: `$HOME/x` and `/tmp/*.txt` were taken and waited on to the end, the file there all along.
  it('a file wait that names a variable, ~name or a pattern is refused at once; ~, ~/, a leading $HOME and a leading $WALNUT_TASK_DIR are taken', () => {
    for (const [file, why] of [
      ['/x/$HOME/out.txt', '($HOME)'], ['$HOMEDIR/out.txt', '($HOMEDIR)'], ['/tmp/$USER/x', '($USER), which is not expanded'],
      ['$WALNUT_TASK_DIR/$RUN/x', '($RUN)'], ['~root/x', 'starts with ~name'], ['/tmp/*.txt', 'has * in it'], ['out?.log', 'has ? in it'],
    ] as const) {
      expect(parseWaitFor({ file }), file).toMatchObject({ ok: false, error: expect.stringContaining(why) })
    }
    // [ and ] are part of a name (2026-11-05 code review: a Next.js route, app/[slug]/page.tsx, was refused).
    for (const file of ['~', '~/out.txt', '$WALNUT_TASK_DIR/out.txt', '${WALNUT_TASK_DIR}/a/b', 'dist/index.html', '/tmp/a$', '/tmp/cost-$5', 'app/[slug]/page.tsx', 'log[12]']) {
      expect(parseWaitFor({ file }), file).toMatchObject({ ok: true, waitFor: { file } })
    }
    // A leading $HOME goes on as ~, which every daemon reads (2026-11-05 review).
    for (const [file, sent] of [['$HOME/out.txt', '~/out.txt'], ['${HOME}/a/b', '~/a/b'], ['$HOME', '~']] as const) {
      expect(parseWaitFor({ file }), file).toMatchObject({ ok: true, waitFor: { file: sent } })
    }
  })

  it('\\A, \\Z and \\z outside a class are refused, as JavaScript reads the letter: ^ and $ are the line\'s ends (2026-11-05 review)', () => {
    for (const [output, e] of [['^ready\\Z', '\\Z'], ['\\Aready', '\\A'], ['done\\z', '\\z']] as const) {
      expect(parseWaitFor({ output }), output).toMatchObject({ ok: false, error: expect.stringContaining(`has ${e}, the start or end of the text`) })
    }
    for (const output of ['[\\A-Z]+', '\\\\A', '\\cZ', 'A\\d']) expect(parseWaitFor({ output }), output).toMatchObject({ ok: true })
  })

  it('grep and PCRE syntax JavaScript reads as something else is refused with what to write (2026-11-05 review 12)', () => {
    for (const [output, why] of [
      ['[[:digit:]]+ passed', 'write \\d instead'], ['\\<done', 'write \\b'], ['done\\>', 'write \\b'], ['\\h+passed', '[ \\t]'],
      ['\\Qdone\\E', "PCRE's quoting"], ['pass\\K', 'lookbehind'], ['done\\x{41}', 'needs the u flag'], ['\\e', 'colour codes are removed'],
      ['\\k', 'no named group'], ['a\\yb', 'no escape for'], ['\\x4z', 'two hex digits'],
    ] as const) {
      expect(parseWaitFor({ output }), output).toMatchObject({ ok: false, error: expect.stringContaining(why) })
    }
    for (const output of ['[\\<>]', '\\d+ ms', '\\bword\\b', 'a\\.b', '\\x41', '\\u0041', '(?<n>a)\\k<n>', '[\\b]', 'a\\/b', '\\t\\v\\f']) {
      expect(parseWaitFor({ output }).ok, output).toBe(true)
    }
    expect(parseWaitFor({ output: '\\u{41}', flags: 'u' }).ok).toBe(true)
  })

  it('a line break written as an escape outside a [...] class is refused: no line holds one (2026-11-05 code review)', () => {
    for (const output of ['a\\x0ab', 'a\\x0Db', 'a\\u000ab', 'a\\cJb', 'a\\cmb', 'a\\u{a}b', 'a\\u{000D}b']) {
      expect(parseWaitFor({ output }).ok, output).toBe(false)
    }
    // Other escapes stay: \x41, \u0041, \cI (a tab), and a line break inside a class.
    for (const output of ['\\x41', '\\u0041', 'a\\cIb', '[\\x0aa]']) expect(parseWaitFor({ output }).ok, output).toBe(true)
  })

  it('a line break inside a [...] class is a character to exclude, not a line break to match', () => {
    expect(parseWaitFor({ output: 'value=[^\\n]+' }).ok).toBe(true)
  })

  it('the octal \\012, and a class of nothing but line breaks, are line breaks too (2026-11-05 code review)', () => {
    for (const output of ['done\\012', 'done\\015', 'done\\12', 'done[\\r\\n]', 'x[\\n]', 'x[\\x0a\\r]']) {
      expect(parseWaitFor({ output }), output).toMatchObject({ ok: false, error: expect.stringContaining('has a line break in it') })
    }
    // A class with anything else in it, a negated one, and \\12 as the back reference it is with 12 groups.
    const twelve = '(a)'.repeat(12)
    for (const output of ['[\\r\\na]', '[^\\r\\n]+', `${twelve}\\12`]) expect(parseWaitFor({ output }).ok, output).toBe(true)
    // \0123 is \012 then 3, and \128 is \12 then 8: a line break each (2026-11-05 code review 11).
    for (const output of ['done\\0123', 'done\\128', 'done\\0152']) {
      expect(parseWaitFor({ output }), output).toMatchObject({ ok: false, error: expect.stringContaining('has a line break in it') })
    }
    // A line break that may be absent matches lines that end without it: ready\r?$ is ready$.
    for (const output of ['ready\\r?$', 'ready\\n*$', 'ready[\\r\\n]*$', 'ok\\x0d{0,1}$', 'ok\\012?']) expect(parseWaitFor({ output }).ok, output).toBe(true)
  })

  it('\\p{...} without the u flag is refused with what to add; with u it is taken (2026-11-05 review)', () => {
    expect(parseWaitFor({ output: '\\p{L}+' })).toMatchObject({ ok: false, error: expect.stringContaining('add "flags": "u"') })
    expect(parseWaitFor({ output: '[\\P{L}]' }).ok).toBe(false)
    expect(parseWaitFor({ output: '\\p{L}+', flags: 'u' }).ok).toBe(true)
    expect(parseWaitFor({ output: '/\\p{L}+/u' }).ok).toBe(true)
    // An escaped backslash before p is the text \\p.
    expect(parseWaitFor({ output: '\\\\p{L}' }).ok).toBe(true)
  })

  it('an inline flag the engine does not read, (?m) or (?s), is refused with where the flags go (2026-11-05 review)', () => {
    for (const output of ['(?m)^ready$', '(?s)a.b', '(?x)ready']) {
      expect(parseWaitFor({ output }), output).toMatchObject({ ok: false, error: expect.stringContaining('Put "i" or "u" in wait_for.flags') })
    }
    // A group the engine reads is no inline flag: (?:...), lookarounds, a named group, a modifier group.
    for (const output of ['(?:ready)', '(?=r)ready', '(?<n>ready)', '(?i:ReAdY)']) expect(parseWaitFor({ output }).ok, output).toBe(true)
  })
})

describe('the patterns it accepts and the ones it refuses', () => {
  // 2026-11-04 reviews: each of these was refused by the cost check, though none is slow on a line.
  const ORDINARY = [
    'ready in \\d+(\\.\\d+)? ?ms', 'Local:\\s+http://\\S+:(\\d+)', '(\\d{1,3}\\.){3}\\d{1,3}', '^(\\d+\\.){3}\\d+',
    '\\b\\d{1,3}(?:\\.\\d{1,3}){3}\\b', '(https?://)?[\\w.-]+:\\d+', '(foo|bar)+', 'Tests:.*(\\d+) passed.*(\\d+) total',
    '\\d+.*\\d+ passed', 'a.*a.*b', '(x)\\1', '(?i:server ready)', '^(?:(?:re|fw):\\s)+', '(?:(?:re|fwd):)+',
    '(\\d+\\.)+\\d+', '\\[(\\d+)/(\\d+)\\]', 'error.*failed|ready.*listening', '(?<port>\\d+)', '(?<=port )\\d+',
    '(\\w|-)+', '([a-z]|\\d)+', '(a|ab)+',
  ]
  it.each(ORDINARY)('accepts %s', (output) => {
    expect(parseWaitFor({ output })).toMatchObject({ ok: true })
  })

  // The textbook exponential shapes: a repeated group whose body matches one text in many ways.
  const TEXTBOOK = [
    '(a+)+$', '(a*)*b', '(?:a*)*b', '(a|a)*b', '(a|aa)+', '(a|aa){2,}b', '(\\w+\\s?)*$', '((ab)+)+', '([a-z]+)+',
    '(a{2,})+', '(\\d+)*', '(?=(?:a|a)*b)', '(?:(?:\\w|\\d))*!', '((a|a)b)*c', '(((a|a)))*$', '^((\\d|\\w)-)*$',
    '(?:[a-z]|[a-z0-9])+$', '(?<g>a+)+!',
  ]
  it.each(TEXTBOOK)('refuses %s before anything runs', (output) => {
    expect(exponentialShape(output)).toBe(true)
    expect(parseWaitFor({ output })).toMatchObject({ ok: false, error: expect.stringContaining('could take too long to run') })
  })

  // 2026-11-04 usability review: `^(\S+\s+)*done$` was refused while `^(\w+ )+ready$` was taken, though
  // neither repeat can match one text in two ways (a word ends where the space starts).
  const DISJOINT_PARTS = [
    '^(\\S+\\s+)*done$', '^(\\w+\\s+)+ready$', '^(\\w+ +)+ready$', '^(\\w+ )+ready$', '^(\\w+\\s)+ready$',
    'v(\\d+\\.)+\\d+', '([0-9]+\\.){3}[0-9]+', '(\\w+,)*\\w+', '^(?:\\w+\\s+)+ready$', '^(?<words>\\S+\\s+)*done$',
    '(?<=: )(\\w+\\s+)+ready', '^(\\w+) (\\w+\\s+)*\\1$', '^([a-z]+[A-Z]+)+$', '(\\w+[-.])+\\w+', '^(\\d+[,.] ?)+$',
  ]
  it.each(DISJOINT_PARTS)('accepts %s: the parts of its repeated group cannot match the same text', (output) => {
    expect(exponentialShape(output)).toBe(false)
    expect(parseWaitFor({ output })).toMatchObject({ ok: true })
  })

  // A repeat that can match one text in more than one way: branches that match the same text, an
  // unbounded part followed by one that matches its characters, an optional part between two that
  // meet across iterations, a body that matches nothing.
  const MANY_WAYS = [
    '(a|a)*b', '^((\\d|\\w)-)*$', '(a+)+$', '(.*)*x', '(\\w+\\w*)+', '^(\\w+\\s?)*$', '(\\d+ ?)+$', '(a*)*',
  ]
  it.each(MANY_WAYS)('refuses %s: its repeated group matches one text in more than one way', (output) => {
    expect(exponentialShape(output)).toBe(true)
    expect(parseWaitFor({ output })).toMatchObject({ ok: false, error: expect.stringContaining('could take too long to run') })
  })

  it('a fixed or counted part does not make a repeat safe; parts that never meet, or an anchor or lookahead that pins its end, do', () => {
    // Ambiguous though each has a fixed or bounded part: `.+` swallows the comma, `{1,3}` splits "12" two ways.
    for (const output of ['(\\w+\\w)+', '(.+,)+$', '(a?b?)*c', '(\\d|\\d\\d)+$', '(\\d{1,3})+$']) expect(exponentialShape(output), output).toBe(true)
    // One path each: the parts never read one character, or an anchor or a lookahead pins where an iteration ends.
    for (const output of ['(?:\\s+\\S+)+$', '(?:\\w+(?:-\\w+)*\\s+)+$', '(^a+)+', '(?:\\w+(?=\\s))+', '(a|ab)+$', '([^,]*,)+$']) expect(exponentialShape(output), output).toBe(false)
  })

  it('letters of both cases meet under the i flag, however it is given', () => {
    expect(parseWaitFor({ output: '^([a-z]+[A-Z]+)+$' })).toMatchObject({ ok: true })
    for (const raw of [{ output: '^([a-z]+[A-Z]+)+$', flags: 'i' }, { output: '(?i)^([a-z]+[A-Z]+)+$' }, { output: '/^([a-z]+[A-Z]+)+$/i' }, { output: '(?i:([a-z]+[A-Z]+)+)$' }]) {
      expect(parseWaitFor(raw), JSON.stringify(raw)).toMatchObject({ ok: false, error: expect.stringContaining('could take too long to run') })
    }
  })

  it('stays quick on the largest repeats a 200-character pattern can write', () => {
    const chars = Array.from({ length: 70 }, (_, k) => String.fromCharCode(48 + k)).filter((c) => /\w/.test(c))
    for (const output of [
      `(?:${chars.join('|')})+`, `(?:${chars.slice(0, 60).map((c) => `${c}?`).join('')})+`, `(?:${'(?:a|ab)'.repeat(23)})+`,
      `(${'a?'.repeat(95)})+`, '(?:(?:a{1,9}b){1,9}(?:a{1,9}b){1,9}(?:a{1,9}b){1,9})+', `${'('.repeat(30)}a|b${')+'.repeat(30)}`,
    ]) {
      const t0 = performance.now()
      exponentialShape(output)
      expect(performance.now() - t0, output).toBeLessThan(200)
    }
  })

  it('the check never runs the caller\'s pattern: a counted repeat of an optional part is checked at once', () => {
    // 2026-11-04 review: the check compiled each branch and tried it on 118 characters, and this one held
    // the server's loop 30 s under node (`{99}`: hours).
    for (const output of ['(?:(?:(?:(?:a?){40}){40}){40}(?=x)|z)+', '(?:(?:(?:(?:a?){99}){99}){99}(?=x)|z)+', '(?:[\\w\\d]|(?:(?:a?){99}){99})+']) {
      const t0 = performance.now()
      parseWaitFor({ output })
      expect(performance.now() - t0, output).toBeLessThan(200)
    }
  })

  it('a huge count of a part that reads no character is checked at once', () => {
    // 2026-11-04 review: the check built one copy per count, and a body like `()` adds no state and
    // no link, so nothing stopped the loop: `(){99999999999999999999,}x` held the server's loop
    // (the check runs before the grant, so any session could) until a restart.
    for (const output of [
      '(){10000000,}x', '(\\b){10000000,}x', '(){99999999999999999999,}x', '((){0,99999999999})+x',
      '(?:^|$){99999999,}x', '(?:(?=a)){99999999}x', '(?:(?:){99999999}){99999999}x', '(a|()){99999999}b',
      // Round 8: a body of many empty groups, built once per count, cost 1.5 s; and one that also reads.
      `((?:${'()'.repeat(90)}){999999999})*`, `((?:${'()'.repeat(85)}a){999999999})*`, `(?:(?:${'(?:)'.repeat(40)}){99999}b?)*c`,
    ]) {
      expect(output.length, output).toBeLessThanOrEqual(200)
      const t0 = performance.now()
      parseWaitFor({ output })
      expect(performance.now() - t0, output).toBeLessThan(200)
    }
  })

  it('branches written the same inside a repeat are refused, however many there are', () => {
    // 2026-11-04 review: with 60 copies of `a` the path search ran out of budget and let it by.
    for (const n of [2, 3, 60, 90]) {
      const output = `(?:${Array(n).fill('a').join('|')})*b`
      const t0 = performance.now()
      expect(parseWaitFor({ output }), `${n} branches`).toMatchObject({ ok: false, error: expect.stringContaining('could take too long to run') })
      expect(performance.now() - t0).toBeLessThan(200)
    }
    // Different branches, or the same text outside any repeat, are fine.
    expect(parseWaitFor({ output: '(?:foo|bar)+ done' })).toMatchObject({ ok: true })
    expect(parseWaitFor({ output: '(?:ok|ok) then (x+)' })).toMatchObject({ ok: true })
  })

  it('every loop that builds copies of a repeat counts its steps (a body may add nothing else that does)', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../src/providers/host-exec-pattern.ts'), 'utf8')
    const loops = src.slice(src.indexOf('function manyWays('), src.indexOf('function largestCount(')).split('\n').filter((l) => /\bfor \(let k\b/.test(l))
    expect(loops.length).toBeGreaterThan(0)
    for (const l of loops) expect(l, l.trim()).toContain('step()')
    // And every node built is a step, whatever it is.
    const build = src.slice(src.indexOf('const build = (s: Shape): Ends => {'))
    expect(build.split('\n').slice(1, 6).join('\n')).toMatch(/^\s*step\(\)$/m)
  })

  it('a group name or a named back-reference with a $ in it is copied as it is into the cut variant', () => {
    // 2026-11-04 review: `(?<a$>x)` became a broken cut pattern and a 500 instead of a wait.
    expect(parseWaitFor({ output: '(?<a$>x)$' })).toMatchObject({ ok: true, pattern: { cut: '(?<a$>x)(?!)' } })
    expect(parseWaitFor({ output: '(?<n>a)\\k<n>$' })).toMatchObject({ ok: true, pattern: { cut: '(?<n>a)\\k<n>(?!)' } })
  })

  it('every accepted pattern is ordinary JavaScript, compiled as given', () => {
    for (const output of ORDINARY) {
      const p = parseWaitFor({ output })
      if (!p.ok) throw new Error(output)
      expect(() => new RegExp(p.pattern!.source, p.pattern!.flags)).not.toThrow()
      expect(() => new RegExp(p.pattern!.cut, p.pattern!.flags)).not.toThrow()
    }
  })
})

describe('linePattern', () => {
  it.each([
    ['.*listening on', 'listening on'], ['^.*ready', 'ready'], ['ready.*', 'ready'], ['ready.*$', 'ready'], ['.*?x.*?', 'x'],
    ['dot\\.*', 'dot\\.*'], ['slash\\\\.*', 'slash\\\\'], ['(a.*)', '(a.*)'], ['a.*b', 'a.*b'],
    ['listening on :\\d+', 'listening on :\\d'], ['\\s*ready', 'ready'], ['^\\s*ready', '^\\s*ready'], ['\\d+ passed', '\\d passed'],
    ['port \\d{2,5}', 'port \\d{2}'], ['port \\d{2,5}$', 'port \\d{2,5}$'], ['ok\\s*$', 'ok\\s*$'],
  ])('%s tests a line as %s', (output, source) => {
    expect(linePattern(output).source).toBe(new RegExp(source).source)
  })

  it('a line matches with it exactly when it matches without it', () => {
    for (const [p, line, want] of [
      ['.*b$', 'aab', true], ['.*b$', 'aba', false], ['^.*\\d', 'x9', true], ['x.*', 'yx', true], ['x.*', 'y', false],
      ['port \\d{2,5}', 'port 8', false], ['port \\d{2,5}', 'port 80', true], ['\\d+\\d+', '7', false], ['\\d+\\d+', 'a 77', true],
      ['ok\\s*$', 'ok  ', true], ['ok\\s*$', 'ok x', false], ['\\s*ready', 'not ready', true],
    ] as const) {
      expect(linePattern(p).test(line), `${p} on ${line}`).toBe(want)
      expect(new RegExp(p).test(line), `${p} as given`).toBe(want)
    }
  })

  it('U+2028 and U+2029 are ordinary characters of a line: a cut repeat at either end means what the pattern says', () => {
    // Code review 6, item 4: `^.*ready`, `build.*$` and `build: x.*$` were false on this line as
    // written (`.` stopped at U+2028) but true as tested (the repeats cut), while `^.{0,50}ready`, never cut, was false.
    const line = 'build: x\u2028ready in 3s'
    for (const p of ['^.*ready', 'build.*$', 'build: x.*$', '^.{0,50}ready', 'x.ready', '^build.{1,40}s$']) {
      expect(linePattern(p).test(line), p).toBe(true)
      // As written, `.` reading any character of the line ([^\n\r]: a line holds neither).
      expect(new RegExp(p.replace(/\./g, '[^\\n\\r]')).test(line), `${p} as written`).toBe(true)
    }
    expect(linePattern('x.ready').test('x\u2029ready')).toBe(true)
  })
})

describe('cutPattern', () => {
  it.each([
    ['a$', 'a(?!)'], ['\\ba\\B', '(?:\\b(?=[^]))a(?:\\B(?=[^]))'], ['[$\\b]x\\$', '[$\\b]x\\$'],
    ['a(?!b)(?<!c)(?=d)', 'a(?!|b)(?<!c)(?=d)'], ['\\\\b', '\\\\b'], ['[\\]$]$', '[\\]$](?!)'],
  ])('cutPattern(%s) is %s', (source, cut) => {
    expect(cutPattern(new RegExp(source, 'i'))).toEqual(new RegExp(cut, 'i'))
  })

  it('`$` never holds on a cut line, a U+2028 inside it included', () => {
    // Code review 6, item 4: `$` became (?=[\n\r\u2028\u2029]), which held before a U+2028 inside a cut line.
    const p = parseWaitFor({ output: 'x$' })
    if (!p.ok) throw new Error(p.error)
    expect(new RegExp(p.pattern!.cut, p.pattern!.flags).test('aax\u2028bb')).toBe(false)
    expect(new RegExp(p.pattern!.cut, p.pattern!.flags).test('aax')).toBe(false)
  })
})
