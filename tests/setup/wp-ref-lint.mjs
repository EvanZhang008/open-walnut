#!/usr/bin/env node
// wp-ref-lint (docs/plan/walnut-replica-servers-impl.md section 12, WP14): every
// `WPn` mention in the plan and in the implementers' checklist files names the
// package that owns the item it talks about.
//
//   node tests/setup/wp-ref-lint.mjs [--plan <plan.md>] [checklist.md ...]
//
// The owner map comes from section 9: each `### WPn` block's "- Files:",
// "- Delivers:" and "- Tests:" bullets list the paths, capabilities and env knobs
// that package owns (one may have several owners: a shared file). Then:
//   1. every `WPn` names a package section 9 defines;
//   2. outside section 9, a line that names packages and paths: each path that
//      section 9 gives an owner is owned by one of the packages that line names
//      (a `path:line` span cites today's code as evidence and is no claim);
//   3. a checklist line (`WPn | rule | test file and test name`): WPn is the
//      checklist's own package (checklist-wpN.md); a test file it names that
//      section 9 gives only to other packages is a note when they are built
//      before or with WPn (a package extends an earlier package's test), and a
//      mismatch when every owner is built after WPn (that test cannot pin the
//      rule when WPn lands). The build order is section 9's Step table.
// Prints `file:line: ...` for each mismatch and exits 1; exit 0 when clean.
import fs from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
let planPath = path.resolve(import.meta.dirname, '../../docs/plan/walnut-replica-servers-impl.md')
const extra = []
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--plan') planPath = path.resolve(args[++i])
  else extra.push(path.resolve(args[i]))
}

const PATH_ROOT = /^(src|tests|scripts|docs|web|ios-native|infra)\//

/** A capability (`replica-logs-v1`) or an env knob (`WALNUT_LEADER_QUIET_MS`): owned like a path. */
const IDENT = /^([a-z][a-z0-9]*(-[a-z0-9]+)*-v\d+|WALNUT_[A-Z0-9_]+)$/

/** The repo paths (and capability or env names) in a backtick span: `:line` dropped, `{a,b}` expanded. */
export function pathsOf(span) {
  const s = span.trim().replace(/:\d+(-\d+)?(,\d+)*$/, '').replace(/[\s=].*$/, '')
  if (IDENT.test(s)) return [s]
  if (!PATH_ROOT.test(s)) return []
  const m = s.match(/^(.*)\{([^}]+)\}(.*)$/)
  if (m) return m[2].split(',').map((x) => `${m[1]}${x.trim()}${m[3]}`)
  return [s]
}

function spansOf(line) {
  return [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1])
}

const WP_RE = /\bWP(\d+)\b/g
const wpsOf = (line) => [...new Set([...line.matchAll(WP_RE)].map((m) => `WP${m[1]}`))]

/** Section 9's owner map, and where section 9 starts and ends. */
export function ownerMap(lines) {
  const owners = new Map()
  const defined = new Set()
  let start = -1
  let end = lines.length
  let wp = null
  let bullet = null
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (/^## 9\./.test(l)) { start = i; continue }
    if (start !== -1 && i > start && /^## /.test(l)) { end = i; break }
    if (start === -1) continue
    const h = l.match(/^### (WP\d+)\b/)
    if (h) { wp = h[1]; defined.add(wp); bullet = null; continue }
    if (!wp) continue
    const b = l.match(/^- ([A-Za-z ]+):/)
    if (b) bullet = b[1].trim()
    if (bullet !== 'Files' && bullet !== 'Tests' && bullet !== 'Delivers') continue
    for (const span of spansOf(l)) {
      for (const p of pathsOf(span)) {
        if (!owners.has(p)) owners.set(p, new Set())
        owners.get(p).add(wp)
      }
    }
  }
  // The build order: `| <step> | WP1, WP2 (...) | ... |` rows of section 9's table.
  const step = new Map()
  for (let i = Math.max(0, start); i < end; i++) {
    const row = lines[i].match(/^\|\s*(\d+)\s*\|([^|]*)\|/)
    if (!row) continue
    for (const w of wpsOf(row[2])) if (!step.has(w)) step.set(w, Number(row[1]))
  }
  return { owners, defined, start, end, step }
}

export function lintPlan(file, text, map) {
  const out = []
  const lines = text.split('\n')
  lines.forEach((l, i) => {
    const wps = wpsOf(l)
    for (const w of wps) if (!map.defined.has(w)) out.push(`${file}:${i + 1}: ${w} is no package of section 9`)
    if (i >= map.start && i < map.end) return
    if (wps.length === 0) return
    for (const span of spansOf(l)) {
      // `path:line` cites the code as it is today (evidence), not who builds it: not a claim.
      if (/:\d+(-\d+)?(,\d+)*\s*$/.test(span.trim())) continue
      for (const p of pathsOf(span)) {
        const own = map.owners.get(p)
        if (own && !wps.some((w) => own.has(w))) out.push(`${file}:${i + 1}: names ${wps.join(', ')} for \`${p}\`, owned by ${[...own].join(', ')}`)
      }
    }
  })
  return out
}

export function lintChecklist(file, text, map, notes = []) {
  const out = []
  const own = path.basename(file).match(/checklist-(wp\d+)\.md$/i)
  const self = own ? own[1].toUpperCase() : null
  text.split('\n').forEach((l, i) => {
    const m = l.match(/^\s*(WP\d+)\s*\|/)
    for (const w of wpsOf(l)) if (!map.defined.has(w)) out.push(`${file}:${i + 1}: ${w} is no package of section 9`)
    if (!m) return
    if (self && m[1] !== self) out.push(`${file}:${i + 1}: a line of ${self}'s checklist names ${m[1]}`)
    const cols = l.split('|')
    const tail = cols.slice(2).join('|')
    const files = [...tail.matchAll(/(?:^|[\s`(])((?:src|tests|scripts|web|ios-native)\/[\w./{},-]+\.(?:ts|tsx|mjs|cjs|js|sh|swift))/g)].flatMap((x) => pathsOf(x[1]))
    for (const p of files) {
      const owners = map.owners.get(p)
      if (!owners || owners.has(m[1])) continue
      const mine = map.step.get(m[1]) ?? Infinity
      const later = [...owners].every((w) => (map.step.get(w) ?? Infinity) > mine)
      const msg = `${file}:${i + 1}: ${m[1]} names \`${p}\`, owned by ${[...owners].join(', ')}`
      if (later) out.push(`${msg}, all built after ${m[1]}`)
      else notes.push(`note: ${msg} (an earlier package's test, extended)`)
    }
  })
  return out
}

function main() {
  const planText = fs.readFileSync(planPath, 'utf8')
  const map = ownerMap(planText.split('\n'))
  if (map.start === -1 || map.defined.size === 0) {
    console.error(`${planPath}: no section 9 work packages found`)
    process.exit(1)
  }
  const problems = [...lintPlan(planPath, planText, map)]
  const notes = []
  for (const f of extra) {
    if (!fs.existsSync(f)) { problems.push(`${f}: not found`); continue }
    problems.push(...lintChecklist(f, fs.readFileSync(f, 'utf8'), map, notes))
  }
  if (process.env.WP_REF_LINT_NOTES === '1') for (const n of notes) console.log(n)
  for (const p of problems) console.log(p)
  console.log(`wp-ref-lint: ${map.defined.size} packages, ${map.owners.size} owned paths, ${1 + extra.length} file(s), ${problems.length} problem(s), ${notes.length} note(s)`)
  process.exit(problems.length ? 1 : 0)
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) main()
