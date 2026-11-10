/**
 * Mail runs every rule condition on the server's one event loop, so a regular expression built from
 * what a person or an agent wrote must go through src/lib/linear-regex (subject patterns via
 * sort-regex-safety.ts, globs via compileGlob). A regex a backtracking engine runs on input-built
 * source is how `.*a.*b.*c.*d` held the loop for 2.5 s on one subject.
 *
 * This lists, over the TypeScript AST of src/integrations/mail and of the matcher itself
 * (src/lib/linear-regex), every place that builds a RegExp from a string (`new RegExp(...)`,
 * `RegExp(...)`) or hands anything but a regex literal to `.match(` / `.matchAll(` / `.search(`
 * (a string there becomes a RegExp too; an object argument is a client's search), and fails on
 * one that is not below with the reason it is safe. Regex literals are fine: they cannot be built
 * from input. Comments and string contents are not code, so they never count. A listed site that is
 * gone fails too, so the list stays true.
 *
 * What it cannot see: a RegExp built in a module these directories do not own and handed rule input
 * at runtime. Mail imports nothing outside them that matches text (checked 2026-11-04); review a new
 * such import by hand.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const SRC = path.resolve(import.meta.dirname, '../../src')
const ROOTS = ['integrations/mail', 'lib/linear-regex']
const STRING_TO_REGEX = new Set(['match', 'matchAll', 'search'])

const KNOWN: Record<string, string> = {
  'integrations/mail/sort-classify.ts: if (rule.match(features)) return { group: rule.group, reason: `rule:${rule.id}`, ruleId: rule.id }':
    "CompiledRule.match, a rule's compiled predicate, not String.prototype.match",
  'integrations/mail/sort-engine.ts: const candidates = rows.filter((row) => rule.match(this.features(row)))':
    "CompiledRule.match, a rule's compiled predicate, not String.prototype.match",
  'integrations/mail/sort-engine.ts: const rows = (await this.deps.store.sort.rowsByIds(accountId, messageIds)).filter((row) => rule.match(this.features(row)))':
    "CompiledRule.match, a rule's compiled predicate, not String.prototype.match",
  'integrations/mail/sort-preview.ts: if (!plan.match(features)) continue': "a preview plan's compiled predicate, not String.prototype.match",
  'integrations/mail/sort-rules-lines.ts: const pattern = new RegExp(`(^|[\\\\s{,-])${escape(key)}\\\\s*:`)':
    'a field name escaped to a literal: no quantifier or group comes from input, so it costs line length x key length',
  'integrations/mail/unsubscribe-link.ts: const href = attributeValue(attrs.match(HREF))': 'HREF is a regex literal constant',
  'integrations/mail/untrusted.ts: const CONTROL_CHARACTERS = new RegExp(': 'a constant character class',
  'integrations/mail/untrusted.ts: const ANGLE_VARIANTS = new RegExp("[\\\\uFF1C\\\\u2039\\\\u3008]", "gu")': 'a constant character class',
  'integrations/mail/untrusted.ts: const ANGLE_VARIANTS_CLOSE = new RegExp("[\\\\uFF1E\\\\u203A\\\\u3009]", "gu")': 'a constant character class',
  'lib/linear-regex/index.ts: new RegExp(source, ignoreCase ? \'i\' : \'\')':
    'validation only: the pattern is compiled to learn whether it is valid, never run',
  'lib/linear-regex/index.ts: ? new RegExp(source, ignoreCase ? \'i\' : \'\') : null':
    'the native fast path, for the shapes fast-path.ts accepts (no lookaround, no property escape, every repeat bounded and of one character or class, at most 8 groups, 16 leaves, 256 steps); the timing test measures their worst',
  'lib/linear-regex/unicode-property.ts: return new RegExp(`^\\\\p{${name}}$`, \'u\')':
    'one anchored property escape whose name is letters, digits and _ only (NAME): it tests one code unit at a time',
  'lib/linear-regex/syntax-error.ts: new RegExp(example, \'i\')':
    'validation only: the example a refusal suggests is compiled to learn whether it is valid, never run',
  'lib/linear-regex/prefilter.ts: return new RegExp(source, factor.ci ? \'i\' : \'\')':
    'an alternation of \\uXXXX-escaped literals, no quantifier: text length x literal length',
  'lib/linear-regex/case-fold.ts: if (new RegExp(source, \'i\').test(subject)) {':
    'the case table check: an anchored run of \\uXXXX escapes built from code units, not from input',
}

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) return sources(full)
    return name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts') ? [full] : []
  })
}

const isRegExpName = (node: ts.Expression): boolean =>
  (ts.isIdentifier(node) && node.text === 'RegExp')
  || (ts.isPropertyAccessExpression(node) && node.name.text === 'RegExp')

/** Each site as `<label>: <the trimmed source line it starts on>`. */
function sitesIn(label: string, text: string): string[] {
  const file = ts.createSourceFile('probe.ts', text, ts.ScriptTarget.Latest, true)
  const lines = text.split('\n')
  const out: string[] = []
  const visit = (node: ts.Node): void => {
    let site = false
    if ((ts.isNewExpression(node) || ts.isCallExpression(node)) && isRegExpName(node.expression)) site = true
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && STRING_TO_REGEX.has(node.expression.name.text)) {
      const first = node.arguments[0]
      // An object argument is some client's search (`client.search({ q })`), never a pattern.
      if (first && !ts.isRegularExpressionLiteral(first) && !ts.isObjectLiteralExpression(first)) site = true
    }
    if (site) out.push(`${label}: ${lines[file.getLineAndCharacterOfPosition(node.getStart(file)).line]!.trim()}`)
    ts.forEachChild(node, visit)
  }
  visit(file)
  return out
}

function sites(): string[] {
  return ROOTS.flatMap((root) => sources(path.join(SRC, root))
    .flatMap((file) => sitesIn(path.relative(SRC, file), readFileSync(file, 'utf8'))))
}

describe('mail rule matchers stay linear', () => {
  it('every RegExp built from a string under src/integrations/mail and src/lib/linear-regex is a known, safe one', () => {
    const found = sites()
    expect(found.filter((site) => !(site in KNOWN))).toEqual([])
    expect(Object.keys(KNOWN).filter((site) => !found.includes(site))).toEqual([])
  })

  it('the scan sees what it is meant to see', () => {
    const probe = (text: string): number => sitesIn('probe.ts', text).length
    expect(probe("const re = new RegExp(`^${source}$`, 'is')")).toBe(1)
    expect(probe('const re = RegExp(pattern)')).toBe(1)
    expect(probe('const re = new globalThis.RegExp(pattern)')).toBe(1)
    expect(probe('subject.match(when.subject.re)')).toBe(1)
    expect(probe('subject.matchAll(needle)')).toBe(1)
    expect(probe('subject.search(needle)')).toBe(1)
    expect(probe('subject.match(/^re: /i)')).toBe(0)
    expect(probe('service.search()')).toBe(0)
    expect(probe('service.search({ q })')).toBe(0)
    expect(probe('let found: RegExpExecArray | null')).toBe(0)
    // Comments and strings are not code, however they read.
    expect(probe("// new RegExp(pattern)\nconst glob = 'a/*'\nconst re = new RegExp(pattern)\n/* subject.match(x) */")).toBe(1)
    expect(probe("const text = 'new RegExp(x) and subject.match(y)'")).toBe(0)
  })
})
