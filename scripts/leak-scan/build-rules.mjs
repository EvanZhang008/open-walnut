#!/usr/bin/env bun
/**
 * Compiles a private rule source into the rule set leak-scan.mjs reads, with every
 * term hashed (scripts/leak-scan/README.md).
 *
 *   bun scripts/leak-scan/build-rules.mjs <source.tsv> [--names <file> <label>]...
 *       [--out <file>] [--base64]
 *
 * source.tsv, one rule per line (# comments and blank lines skipped):
 *   label<TAB>kind<TAB>value[<TAB>allow pattern<TAB>allow pattern...]
 * kind: regex | regex-cs | term | term-cs. A --names file adds one `term` per line under <label>.
 * The source holds the words in the clear, so it stays private (never in a public repo).
 */
import { randomInt } from 'node:crypto'
import fs from 'node:fs'
import { compileRules } from './core.mjs'

export function parseSource(text) {
  const entries = []
  text.split(/\r?\n/).forEach((line, i) => {
    if (!line.trim() || line.trimStart().startsWith('#')) return
    const [label, kind, value, ...allow] = line.split('\t')
    if (!label || !kind || value === undefined || value === '') throw new Error(`line ${i + 1}: expected label<TAB>kind<TAB>value`)
    entries.push({ label, kind, value, allow: allow.filter(Boolean) })
  })
  return entries
}

export function parseNames(text, label) {
  return text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    .map((value) => ({ label, kind: 'term', value }))
}

function main() {
  const argv = process.argv.slice(2)
  const entries = []
  let out = null
  let base64 = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--names') { entries.push(...parseNames(fs.readFileSync(argv[i + 1], 'utf8'), argv[i + 2])); i += 2 }
    else if (a === '--out') out = argv[++i]
    else if (a === '--base64') base64 = true
    else entries.push(...parseSource(fs.readFileSync(a, 'utf8')))
  }
  if (!entries.length) {
    console.error('build-rules: no rules (pass a source.tsv and/or --names <file> <label>)')
    process.exit(2)
  }
  // a fresh salt per build: no table computed for one rule file fits another
  const json = JSON.stringify(compileRules(entries, { seed: randomInt(1, 2 ** 31) }))
  const body = base64 ? Buffer.from(json).toString('base64') : json
  if (out) fs.writeFileSync(out, body, { mode: 0o600 })
  else process.stdout.write(`${body}\n`)
  console.error(`build-rules: ${entries.length} rules`)
}

if (import.meta.main ?? process.argv[1] === new URL(import.meta.url).pathname) main()
