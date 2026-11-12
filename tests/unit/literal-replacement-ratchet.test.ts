/**
 * Ratchet: `.replace` / `.replaceAll` never gets a replacement STRING built at runtime.
 *
 * A replacement string is a pattern, not text: `$&` is the match, `` $` `` the
 * text before it, `$'` the text after it, `$1` a group, `$$` one `$`. When the
 * string carries content (a note, a path, a name, a script), any `$` in it is
 * expanded. On 2026-11-12 note_edit did `content.replace(old_str, new_str)` and an
 * agent's new_str holding "$`" pasted the note's whole text before the match,
 * frontmatter included, into the note.
 *
 * So the second argument must be one of:
 *  - a string literal or a template with no `${}` (the author sees every `$`),
 *  - a function (`() => text` inserts text literally),
 *  - a conditional whose branches are each one of these.
 * Anything else is listed in ALLOWED below with the reason it is safe, and an
 * entry that no longer matches a call fails too, so the list stays true.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(import.meta.dirname, '../..')


/**
 * Calls whose second argument is not a literal or a function, each safe for the
 * reason given. Keyed by file and the argument's exact source text; `count` (1
 * when left out) is how many such calls the file has, so a new call with the
 * same argument text in the same file still fails.
 */
const ALLOWED: Array<{ file: string; arg: string; why: string; count?: number }> = [
  { file: 'src/core/health-monitor/signature.ts', arg: 'to', why: 'FOLDS is a constant table of author-written strings and functions', count: 2 },
  { file: 'src/logging/redact.ts', arg: 'replacement', why: 'constant redaction table whose `$1` is meant as a group reference' },
  { file: 'web/src/utils/redact.ts', arg: 'replacement', why: 'constant redaction table whose `$1` is meant as a group reference' },
  { file: 'scripts/lib/test-timeout-message.mjs', arg: '`$1${TIMEOUT_WORDS}`', why: '`$1` is meant; TIMEOUT_WORDS is a constant with no `$`' },
  { file: 'src/core/integration-loader.ts', arg: 'registered', why: 'registry.replace is the plugin registry, not String.prototype.replace' },
  { file: 'web/src/stores/live-activity-store.ts', arg: 'since', why: 'liveActivityStore.replaceAll is a store method, not String.prototype.replaceAll' },
  { file: 'web/src/components/board/board-markdown.frame.js', arg: "wrap('strong')", why: 'wrap() returns a replacer function' },
  { file: 'web/src/components/board/board-markdown.frame.js', arg: "wrapAfter('strong')", why: 'wrapAfter() returns a replacer function' },
  { file: 'web/src/components/board/board-markdown.frame.js', arg: "wrap('del')", why: 'wrap() returns a replacer function' },
  { file: 'web/src/components/board/board-markdown.frame.js', arg: "wrap('em')", why: 'wrap() returns a replacer function' },
  { file: 'web/src/components/board/board-markdown.frame.js', arg: "wrapAfter('em')", why: 'wrapAfter() returns a replacer function' },
]

function isLiteralOrFunction(node: ts.Expression): boolean {
  if (ts.isParenthesizedExpression(node)) return isLiteralOrFunction(node.expression)
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return true
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return true
  if (ts.isConditionalExpression(node)) return isLiteralOrFunction(node.whenTrue) && isLiteralOrFunction(node.whenFalse)
  return false
}

/** Every `.replace(a, b)` / `.replaceAll(a, b)` in `text` whose `b` is neither a literal nor a function. */
function computedReplacements(file: string, text: string): Array<{ line: number; arg: string }> {
  const kind = /\.[jt]sx$/.test(file) ? ts.ScriptKind.TSX : /\.[cm]?js$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind)
  const out: Array<{ line: number; arg: string }> = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && (node.expression.name.text === 'replace' || node.expression.name.text === 'replaceAll')
      && node.arguments.length === 2
      && !isLiteralOrFunction(node.arguments[1]!)
    ) {
      out.push({ line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, arg: node.arguments[1]!.getText(sf) })
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

/** Every tracked JS/TS file except tests (a test may build a pattern on purpose) and vendored code. */
function sourceFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf-8', maxBuffer: 64 << 20 })
  return out.split('\0').filter((f) =>
    /\.(?:[cm]?[jt]s|[jt]sx)$/.test(f)
    && !f.endsWith('.d.ts')
    && !/^tests\//.test(f)
    && !/(?:^|\/)(?:node_modules|dist|vendor|__tests__)\//.test(f)
    && !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(f)
    && fs.existsSync(path.join(ROOT, f)))
}

describe('replacement strings are literal or a function', () => {
  it('the detector flags a computed replacement and passes the safe shapes', () => {
    const src = [
      'a.replace(x, newStr)',
      'a.replaceAll(x, `${y}!`)',
      'a.replace(x, prefix + y)',
      "a.replace(x, '$1-')",
      'a.replace(x, `plain`)',
      'a.replace(x, () => newStr)',
      'a.replace(x, function (m) { return m })',
      "a?.replace(x, cond ? '' : '$&')",
      'a.replace(x)',
    ].join('\n')
    expect(computedReplacements('probe.ts', src)).toEqual([
      { line: 1, arg: 'newStr' },
      { line: 2, arg: '`${y}!`' },
      { line: 3, arg: 'prefix + y' },
    ])
  })

  it('no replace call in the source passes a computed replacement string', () => {
    const offenders: string[] = []
    const seen = ALLOWED.map(() => 0)
    for (const file of sourceFiles()) {
      const text = fs.readFileSync(path.join(ROOT, file), 'utf-8')
      if (!/\.replace(?:All)?\(/.test(text)) continue
      for (const hit of computedReplacements(file, text)) {
        const i = ALLOWED.findIndex((a) => a.file === file && a.arg === hit.arg)
        if (i >= 0) seen[i]! += 1
        else offenders.push(`${file}:${hit.line}: replacement ${hit.arg.replace(/\s+/g, ' ').slice(0, 120)}`)
      }
    }
    expect(
      offenders,
      'a replacement string expands $&, $`, $\', $1 and $$: pass a function (`() => text`) so the text goes in literally, '
        + 'or add the call to ALLOWED with the reason it is safe',
    ).toEqual([])
    const miscounted = ALLOWED.flatMap((a, i) =>
      seen[i] === (a.count ?? 1) ? [] : [`${a.file}: ${a.arg} (allowed ${a.count ?? 1}, found ${seen[i]})`])
    expect(
      miscounted,
      'ALLOWED counts no longer match the source: a new call with a computed replacement takes a function instead, '
        + 'and an entry whose call is gone is removed',
    ).toEqual([])
  })
})
