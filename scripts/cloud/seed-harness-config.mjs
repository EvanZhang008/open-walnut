#!/usr/bin/env node
/**
 * Seed the cloud companion's config.yaml with the keys that make it an exec
 * host. Run by scripts/cloud/ensure-harness.sh as the service user, so the file
 * stays owned by the user the server runs as.
 *
 *   --config <file>     config.yaml to edit (created when absent)
 *   --repo <dir>        checkout whose node_modules provides js-yaml
 *   --exec-root <dir>   seed cloud.exec.enabled: true + cloud.exec.cwd_roots: [dir]
 *   --engine <id>       seed defaults.engine
 *   --dry-run           compute and report, write nothing
 *   --print-engine      print the current defaults.engine (or an empty line), exit
 *
 * Only ever ADDS keys that are absent. A key the operator wrote is theirs, even
 * `enabled: false` or an empty list.
 *
 * The only library is js-yaml: the parser the server reads config.yaml with,
 * and a runtime dependency, so every install has it. It cannot write a file
 * back with its comments, so nothing is ever re-serialized. Each key is a TEXT
 * insertion and every other byte stays as it was (comments, key order, a scalar
 * spelled by hand):
 *   - under a top-level key the file does not have yet, the new block is
 *     appended at the end;
 *   - under an existing block mapping, it goes after that mapping's last line,
 *     at the indentation of its children.
 * Each insertion is then PROVEN by loading the result with js-yaml: it must
 * equal the old values plus exactly the new key. A shape the insertion does not
 * handle (a flow mapping `{...}`, an anchor, a document end marker) fails that
 * proof, and the key is reported `warned` and left out. The write is atomic
 * (sibling temp + rename) so a server reading config.yaml mid-write never sees
 * half a file.
 *
 * `defaults` is seeded as `{engine}` alone on purpose: the server merges the
 * parsed file over its defaults at the TOP level, but every reader of
 * `defaults.priority` / `defaults.platform` already handles their absence.
 *
 * Output: one `key<TAB>status<TAB>detail` line per key, status one of seeded,
 * present, planned, warned. Exit 3 (message on stderr) when the file cannot be
 * read, parsed, or written, in which case nothing was changed.
 */
import fs from 'node:fs'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { createRequire } from 'node:module'

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exit(3)
}

function parseArgs(argv) {
  const out = { dryRun: false, printEngine: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const value = () => {
      if (i + 1 >= argv.length) fail(`seed-harness-config: ${arg} needs a value`)
      return argv[++i]
    }
    if (arg === '--config') out.config = value()
    else if (arg === '--repo') out.repo = value()
    else if (arg === '--exec-root') out.execRoot = value()
    else if (arg === '--engine') out.engine = value()
    else if (arg === '--dry-run') out.dryRun = true
    else if (arg === '--print-engine') out.printEngine = true
    else fail(`seed-harness-config: unknown argument ${arg}`)
  }
  if (!out.config || !out.repo) fail('seed-harness-config: --config and --repo are required')
  return out
}

const args = parseArgs(process.argv.slice(2))
const file = args.config

let jsyaml
try {
  jsyaml = createRequire(path.join(args.repo, 'package.json'))('js-yaml')
} catch {
  fail(`js-yaml is not installed under ${args.repo}/node_modules (run npm ci there); nothing was changed`)
}

let text = ''
let mode = 0o600
try {
  mode = fs.statSync(file).mode & 0o777
  text = fs.readFileSync(file, 'utf-8')
} catch (err) {
  if (err.code !== 'ENOENT') fail(`cannot read ${file} (${err.message}); nothing was changed`)
}

const isMap = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)
const firstLine = (s) => String(s).split('\n')[0]

let current
try {
  current = jsyaml.load(text)
} catch (err) {
  fail(`${file} does not parse as YAML (${firstLine(err.message)}); fix it by hand, nothing was changed`)
}
if (current === undefined || current === null) current = {}
if (!isMap(current)) fail(`${file} is not a YAML mapping at the top level; nothing was changed`)

if (args.printEngine) {
  const engine = isMap(current.defaults) ? current.defaults.engine : undefined
  process.stdout.write(`${typeof engine === 'string' ? engine : ''}\n`)
  process.exit(0)
}

// The server restores a missing or empty config.yaml from config.yaml.bak
// (config-manager.ts readRawConfigContent). Writing a fresh file here would
// shadow that backup, so leave the recovery to the server.
if (!text.trim()) {
  let backup = ''
  try { backup = fs.readFileSync(`${file}.bak`, 'utf-8') } catch { /* no backup */ }
  if (backup.trim()) {
    fail(`${path.basename(file)} is missing or empty but ${path.basename(file)}.bak has content; start the server once so it restores the file, then run this again. Nothing was changed`)
  }
}
if (!fs.existsSync(path.dirname(file))) fail(`data directory ${path.dirname(file)} does not exist; nothing was changed`)

// ── Text model: lines keep their own terminators, so joining is lossless ────
const EOL = text.includes('\r\n') ? '\r\n' : '\n'
const splitLines = (src) => src.match(/[^\n]*\n|[^\n]+$/g) ?? []
const bodyOf = (line) => line.replace(/\r?\n$/, '')
const indentOf = (line) => bodyOf(line).match(/^ */)[0].length
const isContent = (line) => {
  const t = bodyOf(line).trim()
  return t !== '' && !t.startsWith('#')
}
function firstContent(lines, from, to) {
  for (let i = from; i < to; i++) if (isContent(lines[i])) return i
  return -1
}
function lastContent(lines, from, to) {
  for (let i = to - 1; i >= from; i--) if (isContent(lines[i])) return i
  return -1
}
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** `key:` with nothing after it but a comment: a block mapping (or empty) value. */
const blockKeyRe = (key) => new RegExp(`^(?:${escapeRe(key)}|'${escapeRe(key)}'|"${escapeRe(key)}")[ \\t]*:[ \\t]*(?:#.*)?$`)

/**
 * The key line of the block mapping at `keys`, and the line range of its
 * children. Null when the file does not spell that path as plain block keys.
 */
function findBlockKey(lines, keys) {
  let from = 0
  let to = lines.length
  let keyIndent = -1
  let keyLine = -1
  for (const key of keys) {
    const first = firstContent(lines, from, to)
    if (first === -1) return null
    const childIndent = indentOf(lines[first])
    if (childIndent <= keyIndent) return null
    const re = blockKeyRe(key)
    let found = -1
    for (let i = first; i < to && found === -1; i++) {
      if (isContent(lines[i]) && indentOf(lines[i]) === childIndent && re.test(bodyOf(lines[i]).slice(childIndent))) found = i
    }
    if (found === -1) return null
    keyLine = found
    keyIndent = childIndent
    from = found + 1
    let end = to
    for (let i = from; i < to; i++) {
      if (isContent(lines[i]) && indentOf(lines[i]) <= keyIndent) { end = i; break }
    }
    to = end
  }
  return { keyLine, keyIndent, from, to }
}

/** `value` as YAML lines at `indent`, in the file's line ending. */
function block(obj, indent) {
  const dumped = jsyaml.dump(obj, { lineWidth: -1, noRefs: true })
  return dumped.split('\n').filter(Boolean).map((l) => `${' '.repeat(indent)}${l}${EOL}`).join('')
}

function nest(keys, value) {
  return keys.reduceRight((inner, key) => ({ [key]: inner }), value)
}

function withKey(obj, keys, value) {
  const out = structuredClone(obj)
  let node = out
  for (const k of keys.slice(0, -1)) {
    if (!isMap(node[k])) node[k] = {}
    node = node[k]
  }
  node[keys[keys.length - 1]] = structuredClone(value)
  return out
}

/** `text` with `keys: value` added, or a reason it cannot be done safely. */
function insert(src, obj, keys, value) {
  // Deepest path prefix the file already has; every level of it must be a map
  // (the last may be empty, `cloud:` alone loads as null).
  let depth = 0
  let node = obj
  while (depth < keys.length - 1 && isMap(node) && Object.prototype.hasOwnProperty.call(node, keys[depth])) {
    node = node[keys[depth]]
    depth++
    if (node !== null && !isMap(node)) return { reason: `${keys.slice(0, depth).join('.')} is not a mapping` }
  }
  const lines = splitLines(src)
  const subtree = nest(keys.slice(depth), value)
  let next
  if (depth === 0) {
    const first = firstContent(lines, 0, lines.length)
    const indent = first === -1 ? 0 : indentOf(lines[first])
    const sep = src === '' || src.endsWith('\n') ? '' : EOL
    next = src + sep + block(subtree, indent)
  } else {
    const loc = findBlockKey(lines, keys.slice(0, depth))
    if (!loc) return { reason: `${keys.slice(0, depth).join('.')} is not written as a plain block mapping` }
    const firstChild = firstContent(lines, loc.from, loc.to)
    const indent = firstChild === -1 ? loc.keyIndent + 2 : indentOf(lines[firstChild])
    const at = firstChild === -1 ? loc.keyLine + 1 : lastContent(lines, loc.from, loc.to) + 1
    if (!lines[at - 1].endsWith('\n')) lines[at - 1] += EOL
    lines.splice(at, 0, block(subtree, indent))
    next = lines.join('')
  }
  const want = withKey(obj, keys, value)
  let got
  try { got = jsyaml.load(next) } catch { got = undefined }
  if (!isDeepStrictEqual(got, want)) return { reason: 'the file is laid out in a way this script cannot extend safely' }
  return { text: next, obj: want }
}

const lines = []
let changed = false
const report = (key, status, detail) => lines.push(`${key}\t${status}\t${detail}`)

function has(obj, keys) {
  let node = obj
  for (const k of keys) {
    if (!isMap(node) || !Object.prototype.hasOwnProperty.call(node, k)) return { found: false }
    node = node[k]
  }
  return { found: true, value: node }
}

function seed(keys, value) {
  const key = keys.join('.')
  const existing = has(current, keys)
  if (existing.found) {
    report(key, 'present', `kept ${JSON.stringify(existing.value)}`)
    return
  }
  const result = insert(text, current, keys, value)
  if (result.reason) {
    report(key, 'warned', `${result.reason}; left alone, add it by hand`)
    return
  }
  text = result.text
  current = result.obj
  changed = true
  report(key, args.dryRun ? 'planned' : 'seeded', JSON.stringify(value))
}

if (args.execRoot) {
  seed(['cloud', 'exec', 'enabled'], true)
  seed(['cloud', 'exec', 'cwd_roots'], [args.execRoot])
}
if (args.engine) seed(['defaults', 'engine'], args.engine)

if (changed && !args.dryRun) {
  const tmp = `${file}.tmp-harness-${process.pid}`
  try {
    fs.writeFileSync(tmp, text, { mode })
    fs.chmodSync(tmp, mode)
    fs.renameSync(tmp, file)
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }) } catch { /* best effort */ }
    fail(`cannot write ${file} (${err.message}); nothing was changed`)
  }
}

if (lines.length > 0) process.stdout.write(`${lines.join('\n')}\n`)
