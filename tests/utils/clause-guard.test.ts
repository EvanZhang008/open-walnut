/**
 * Guard: an interpolated error or reason value that a sentence period follows goes through
 * clause()/errClause() (src/utils/format.ts), never straight into "${why}. Next sentence". A value
 * that already ends in a period then read "id.." (2026-11-25: "The switch to Antigravity did not
 * start: ... retry task_start with the same id.. The task stays on Claude.").
 *
 * The class, as this test reads it from every file under src/: a `${...}` whose expression ends in
 * a value named for a failure or a reason (why, reason, cause, error, err, e, detail, problem,
 * failure, message, msg, errorMessage, errMsg, as a name or a property: `${gone.why}`), or in
 * String(err) / errText(err), followed by a period that ends a sentence (a space, a quote, a
 * backtick, the next `${`, or the line's end; never a file extension like `${e}.md`). A value named
 * otherwise is outside what this guard sees.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { clause, errClause } from '../../src/utils/format.js'

const SRC = path.resolve(import.meta.dirname, '../../src')

const JOIN = /\$\{([^{}]*?)\}\.(?=[\s'"`]|\$\{|$)/g
const FAILURE_NAME = /^(?:why|reason|cause|error|err|e|detail|problem|failure|message|msg|errorMessage|errMsg)$/

/** The joins on `line` that read a failure's or a reason's words straight before a sentence period. */
function rawJoins(line: string): string[] {
  const out: string[] = []
  for (const m of line.matchAll(JOIN)) {
    const expr = m[1].trim()
    const last = expr.split(/[\s?:|&]+/).pop() ?? ''
    const name = last.split('.').pop() ?? ''
    if (FAILURE_NAME.test(name) || /\b(?:errText|String)\((?:err|e|error)\)$/.test(expr)) out.push(m[0])
  }
  return out
}

function tsFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) out.push(...tsFiles(p))
    else if (/\.tsx?$/.test(name)) out.push(p)
  }
  return out
}

describe('clause', () => {
  it('drops the words\' own end stop and trailing space, nothing else', () => {
    expect(clause('Fix the cause and retry task_start with the same id.')).toBe('Fix the cause and retry task_start with the same id')
    expect(clause('no stop')).toBe('no stop')
    expect(clause('two.. \n')).toBe('two')
    expect(clause('v1.2 failed')).toBe('v1.2 failed')
    expect(errClause(new Error('gone.'))).toBe('gone')
    expect(errClause('plain.')).toBe('plain')
  })

  it('reads a long run of dots and spaces in outside text in linear time, and agrees with /[.\\s]+$/', () => {
    const long = '. '.repeat(50_000) + 'tail'
    const started = performance.now()
    expect(clause(long)).toBe(long)
    expect(clause(long + ' . . ')).toBe(long)
    expect(performance.now() - started).toBeLessThan(200)
    for (const t of ['a.\u00a0', 'b\u2003.', 'c\ufeff', 'd\t\n.', '...', '', 'x . y']) expect(clause(t)).toBe(t.replace(/[.\s]+$/, ''))
  })

  it('the pattern below finds the join that read "id..", and the rest of its class', () => {
    // The engine switch's line before the fix.
    expect(rawJoins('did not start: ${err instanceof Error ? err.message : String(err)}. The task stays')).toHaveLength(1)
    expect(rawJoins('could not start: ${message}. A setting')).toHaveLength(1)
    expect(rawJoins('`gave up: ${why}.`')).toHaveLength(1)
    expect(rawJoins('it ended (${gone.why}).${next}')).toHaveLength(0)
    expect(rawJoins('left: ${cause}.${next} more')).toHaveLength(1)
    expect(rawJoins('did not start: ${errClause(err)}. The task stays')).toHaveLength(0)
    expect(rawJoins('k === `${e}.md`')).toHaveLength(0)
    expect(rawJoins('${count}. items')).toHaveLength(0)
  })

  it('no source joins an error message to a next sentence without clause()', () => {
    const hits: string[] = []
    for (const file of tsFiles(SRC)) {
      const lines = readFileSync(file, 'utf8').split('\n')
      lines.forEach((line, i) => { for (const j of rawJoins(line)) hits.push(`${path.relative(SRC, file)}:${i + 1}: ${j}`) })
    }
    expect(hits, 'wrap the message in clause() or errClause() (src/utils/format.ts)').toEqual([])
  })
})
