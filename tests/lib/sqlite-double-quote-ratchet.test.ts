/**
 * Ratchet: SQL in src/ never writes a string in double quotes.
 *
 * SQLite builds differ on `"x"`. Walnut's macOS build is compiled with DQS=0
 * (scripts/build-sqlite-dylib.mjs, as better-sqlite3 was), so a double-quoted
 * token is a name only, and one that names no column is an error. bun's own
 * SQLite on Linux keeps SQLite's default, where such a token quietly becomes a
 * string. `WHERE state = "done"` would then be a query that fails on the Mac
 * and works on a Linux host, and nothing in bun:sqlite turns that default off.
 * A string is written in single quotes, a name bare.
 *
 * Every string and template literal in src/ that has the shape of SQL is read
 * with SQL comments and single-quoted strings removed; any double quote left
 * must be one of the two names Walnut quotes on purpose: an interpolated index
 * or table name (`DROP INDEX IF EXISTS "${name}"`), or an FTS5 option, whose
 * value FTS5 parses itself (`tokenize="${FTS_TOKENIZE}"`).
 */
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(import.meta.dirname, '../..')

/** Text that reads as SQL: a statement's head or a clause. Walnut writes SQL keywords in capitals. */
const SQL = /\bSELECT\b[\s\S]*\bFROM\b|\bINSERT\s+(?:OR\s+[A-Z]+\s+)?INTO\b|\bUPDATE\s+\w+\s+SET\b|\bDELETE\s+FROM\b|\b(?:CREATE|DROP)\s+(?:UNIQUE\s+|VIRTUAL\s+|TEMP\s+)?(?:TABLE|INDEX|VIEW|TRIGGER)\b|\bALTER\s+TABLE\b|\bPRAGMA\s+\w|\bWHERE\s+[\w.(]|\bFROM\s+\w|\bVALUES\s*\(|\b(?:ORDER|GROUP)\s+BY\s+\w|\bJOIN\s+\w/

/** A double quote Walnut means: an interpolated name after INDEX/TABLE/VIEW/TRIGGER (a schema before it too), or an FTS5 option's value. */
const QUOTED_NAME = /(?:\b(?:INDEX|TABLE|VIEW|TRIGGER)(?:\s+IF(?:\s+NOT)?\s+EXISTS)?\s+(?:\w+\.)?|\btokenize\s*=\s*)"\$\{\}"/g

/** Interpolations read as `${}`; SQL comments and single-quoted strings removed. */
function strayDoubleQuotes(sql: string): boolean {
  const bare = sql
    .replace(/--[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/'(?:[^']|'')*'/g, "''")
  return SQL.test(bare) && bare.replace(QUOTED_NAME, '').includes('"')
}

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : sourceFiles(full)
    return /\.(?:ts|tsx|mts|cts)$/.test(e.name) && !e.name.endsWith('.d.ts') ? [full] : []
  })
}

/** Every SQL-shaped literal in `file` that keeps a double quote, as `file:line: text`. */
function offendersIn(file: string, text: string): string[] {
  const out: string[] = []
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const visit = (node: ts.Node): void => {
    let literal: string | null = null
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) literal = node.text
    else if (ts.isTemplateExpression(node)) literal = node.head.text + node.templateSpans.map((span) => `\${}${span.literal.text}`).join('')
    if (literal !== null && strayDoubleQuotes(literal)) {
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
      out.push(`${path.relative(ROOT, file).split(path.sep).join('/')}:${line}: ${literal.replace(/\s+/g, ' ').trim().slice(0, 160)}`)
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

describe('SQL in src/ writes strings in single quotes', () => {
  it('no SQL-shaped literal keeps a double quote', () => {
    const offenders = sourceFiles(path.join(ROOT, 'src')).flatMap((file) => {
      const text = fs.readFileSync(file, 'utf8')
      return SQL.test(text) ? offendersIn(file, text) : []
    })
    expect(offenders, 'write a SQL string as \'x\' and a name bare: Linux bun\'s SQLite reads "x" that names no column as a string, Walnut\'s macOS build refuses it').toEqual([])
  })

  it('finds a double-quoted string, and lets names, comments and prose through', () => {
    for (const bad of [
      'SELECT id FROM tasks WHERE state = "done"',
      'UPDATE tasks SET phase = "COMPLETE" WHERE id = ?',
      ' WHERE kind = "${}" AND id = ?',
      'INSERT INTO t (a) VALUES ("x")',
      'CREATE TABLE "tasks" (id TEXT)',
    ]) expect(strayDoubleQuotes(bad), bad).toBe(true)
    for (const good of [
      "SELECT id FROM tasks WHERE state = 'done'",
      "SELECT name FROM sqlite_master WHERE name LIKE 'say \"hi\"'",
      'DROP INDEX IF EXISTS "${}";',
      'DROP TRIGGER IF EXISTS main."${}"',
      "CREATE UNIQUE INDEX IF NOT EXISTS \"${}\" ON tasks(json_extract(ext, '${}'))",
      'CREATE VIRTUAL TABLE IF NOT EXISTS doc_fts USING fts5(title, tokenize="${}")',
      'CREATE TABLE t (\n  -- asks "is there any"\n  id TEXT\n)',
      'Replace the FULL content ("global" = MEMORY.md)',
    ]) expect(strayDoubleQuotes(good), good).toBe(false)
  })
})
