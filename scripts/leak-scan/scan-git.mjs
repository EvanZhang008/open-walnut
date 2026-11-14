#!/usr/bin/env bun
/**
 * scan-git: the one leak gate for what git makes public from this repository. Every way a
 * change reaches GitHub runs it: the pre-commit and commit-msg hooks, the pre-push hook
 * (scan-push.sh), a land, CI on every push and pull request, and the write-time guard of an
 * agent's file edits (scripts/leak-scan/README.md).
 *
 *   bun scripts/leak-scan/scan-git.mjs --staged              the index against HEAD (pre-commit)
 *   bun scripts/leak-scan/scan-git.mjs --range <A>..<B>      every commit in A..B, one by one
 *   bun scripts/leak-scan/scan-git.mjs --history [<rev>]     every commit <rev> holds (CI), known
 *                                                            hits matched by fingerprint
 *   bun scripts/leak-scan/scan-git.mjs --message-file <f>    a commit message (commit-msg)
 *   bun scripts/leak-scan/scan-git.mjs --text <path>         stdin as new content of <path>
 *
 * What it reads: each added line (with its file and line number), each added or renamed file's
 * name, the text inside binary files, each commit's message, author and committer. What it
 * applies: the committed shapes (shapes.tsv), the private rules (terms hashed; --rules,
 * --rules-env, `git config walnut.leakRules`, else ~/.config/walnut-leak/leak-rules.json),
 * gitleaks (its default rules and .gitleaks.toml), and three file rules: a file over 2 MB, a
 * file of private data (a path under .open-walnut/ or .claude/projects/, a session transcript
 * or a Walnut store file outside tests/fixtures/), and an image, video or sound outside the
 * asset folders (a screenshot of someone's screen).
 *
 * Strict (on by itself where ~/.config/walnut-leak exists, the maintainer's machines, and
 * with WALNUT_LEAK_STRICT=1, CI in the upstream repository): no private rules or no gitleaks
 * is an error, never a skip. Elsewhere (a contributor) both are used when present.
 *
 * The scanner and the gitleaks config that judge a range are the BASE commit's, when it has
 * them: a change can never loosen the scan that judges it (a weaker rule, an allowlist line);
 * it takes effect for the changes after it.
 *
 * Options: --redact (the rule and the place, never the text: public logs), --repo <dir>,
 * --fingerprints (history: print each new hit's fingerprint, for the baseline).
 * There is no option to skip a check, and none will be added: a hit is fixed by rewording.
 * Exit: 0 clean, 1 hits, 2 could not check.
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseSource } from './build-rules.mjs'
import { binaryHits, compileRules, decodeRules, loadRules, printableRuns, scanText } from './core.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ZERO = /^0+$/
export const MAX_FILE_BYTES = 2 * 1024 * 1024
const MEDIA = /\.(png|jpe?g|gif|webp|heic|bmp|tiff?|mp4|mov|m4v|webm|mkv|avi|mp3|wav|caf|m4a|aac|ogg|opus|flac)$/i
// where pictures and sounds belong: the site, the docs, the app's own assets and icons
// compressed containers: their text cannot be read here, so they belong only where media do
const OPAQUE = /\.(zip|tgz|gz|bz2|xz|zst|tar|7z|rar|jar|pdf|docx?|xlsx?|pptx?|key|numbers|pages|sqlite3?|db)$/i
const FIXTURE_DIR = /(^|\/)[Ff]ixtures?\//
const ASSET_DIRS = /^(site\/assets|docs|web\/public|ios\/assets|desktop(-windows)?\/(ui|assets|resources|build)|tests\/fixtures\/media)\/|\.xcassets\/|^ios-native\/[^/]+\/(Resources|Assets|Talk|Fixtures)\//
const PRIVATE_DATA = /(^|\/)\.open-walnut\/|(^|\/)\.claude\/projects\/|(^|\/)\.walnut\/(tasks|sessions|memory|notes)/
const STORE_FILE = /(^|\/)(tasks|sessions|chat-history[a-z-]*|conversations|human-inbox[a-z-]*)\.json$|\.jsonl$/
const FIXTURES = /^tests\/(fixtures|setup)\//

export const FIX = 'Replace the flagged text with neutral invented words (or move the file), then commit again. No flag skips this scan.'

// ── Rules ───────────────────────────────────────────────────────────────────

export function shapeRules(dir = HERE) {
  return loadRules(compileRules(parseSource(fs.readFileSync(path.join(dir, 'shapes.tsv'), 'utf8'))), { scope: 'source' })
}

function gitOut(repo, args, opts = {}) {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: opts.buffer ? undefined : 'utf8', maxBuffer: 1 << 30, env: opts.env ?? process.env })
  if (r.status !== 0) {
    if (opts.ok) return null
    throw new Error(`git ${args.slice(0, 3).join(' ')} failed: ${(r.stderr || '').toString().trim().split('\n').pop()}`)
  }
  return r.stdout
}

/**
 * The private rules' file or env text, or null when there are none. Strict reads only the
 * global `walnut.leakRules` (or the default file): a repository's own config is anyone's to edit.
 */
export function findPrivate(opts, repo, env = process.env, strict = false) {
  if (opts.rulesEnv) {
    const raw = env[opts.rulesEnv]
    return raw && raw.trim() ? decodeRules(raw) : null
  }
  const file = opts.rules
    || (gitOut(repo, ['config', ...(strict ? ['--global'] : []), '--path', '--get', 'walnut.leakRules'], { ok: true }) || '').trim()
    || path.join(os.homedir(), '.config/walnut-leak/leak-rules.json')
  return fs.existsSync(file) ? decodeRules(fs.readFileSync(file, 'utf8')) : null
}

export function isStrict(opts, env = process.env) {
  return opts.strict || env.WALNUT_LEAK_STRICT === '1' || fs.existsSync(path.join(os.homedir(), '.config/walnut-leak'))
}

// ── Collecting what git publishes ───────────────────────────────────────────

/** C-quoted git path ("a\tb") to its bytes as text. */
export function unquote(p) {
  if (!p.startsWith('"')) return p
  const body = p.slice(1, -1)
  const bytes = []
  for (let i = 0; i < body.length; i++) {
    const c = body[i]
    if (c !== '\\') { bytes.push(...Buffer.from(c)); continue }
    const n = body[++i]
    if (/[0-7]/.test(n)) { bytes.push(parseInt(body.slice(i, i + 3), 8)); i += 2 }
    else bytes.push({ n: 10, t: 9, r: 13, '"': 34, '\\': 92, a: 7, b: 8, f: 12, v: 11 }[n] ?? n.charCodeAt(0))
  }
  return Buffer.from(bytes).toString('utf8')
}

const COMMIT_MARK = '\x00\x00COMMIT '
const END_MARK = '\x00\x00END'
const LOG_FORMAT = '--format=%x00%x00COMMIT %H%n%an <%ae>%n%cn <%ce>%n%B%x00%x00END'

/**
 * Reads the units git output describes: { commit, author, committer, message, files } per
 * commit (a staged diff is one unit with no commit). A file is { path, blob, status, binary,
 * lines: [[lineNo, text]] }. `onUnit` (synchronous) gets each one as it completes. Lines are
 * handled inside the stream's own data events, so git waits while a unit is checked and its
 * output never piles up in memory (a whole history is about a gigabyte of patches).
 */
export function lineParser(onUnit) {
  let unit = null
  let file = null
  let state = 'raw' // head (author, committer), msg, raw, header, hunk
  let headLeft = 0
  let newLine = 0
  const msg = []
  const flush = () => {
    if (unit) onUnit(unit)
    unit = null
    file = null
  }
  const start = (commit) => {
    unit = { commit, author: '', committer: '', message: '', files: [], raw: new Map() }
  }
  const hunkStart = (line) => {
    const m = /\+(\d+)/.exec(line)
    newLine = m ? Number(m[1]) : 0
  }
  const line = (l) => {
    if (l.startsWith(COMMIT_MARK)) {
      flush()
      start(l.slice(COMMIT_MARK.length).trim())
      state = 'head'
      headLeft = 2
      msg.length = 0
      return
    }
    if (!unit) start(null)
    if (state === 'head') {
      if (headLeft === 2) unit.author = l
      else unit.committer = l
      if (--headLeft === 0) state = 'msg'
      return
    }
    if (state === 'msg') {
      if (l.endsWith(END_MARK)) {
        if (l !== END_MARK) msg.push(l.slice(0, -END_MARK.length))
        unit.message = msg.join('\n').replace(/\n+$/, '')
        state = 'raw'
      } else msg.push(l)
      return
    }
    if (state === 'hunk') {
      if (l.startsWith('+')) { file?.lines.push([newLine++, l.slice(1)]); return }
      if (l.startsWith(' ')) { newLine++; return }
      if (l.startsWith('-') || l.startsWith('\\')) return
      if (l.startsWith('@@')) { hunkStart(l); return }
      state = 'raw'
    }
    if (l.startsWith(':') && state === 'raw') {
      // :100644 100644 <old> <new> M\tpath
      const [meta, ...paths] = l.split('\t')
      const parts = meta.split(' ')
      const status = parts[4]?.[0] ?? 'M'
      const p = unquote(paths[paths.length - 1] ?? '')
      if (status !== 'D') unit.raw.set(p, { blob: parts[3], status, mode: parts[1] })
      return
    }
    if (l.startsWith('diff --git ') || l.startsWith('diff --cc ') || l.startsWith('diff --combined ')) {
      state = 'header'
      file = null
      return
    }
    if (state === 'header') {
      if (l.startsWith('+++ ')) {
        const p = l.slice(4).replace(/\t$/, '')
        if (p !== '/dev/null') {
          const name = unquote(p).replace(/^b\//, '')
          file = { path: name, lines: [], binary: false, ...(unit.raw.get(name) ?? {}) }
          unit.files.push(file)
        }
      } else if (l.startsWith('Binary files ') && l.endsWith(' differ')) {
        // the name is matched against the raw list (a path may hold " and "); one not found
        // there is still read: withRawOnly adds every raw entry no patch named
        const body = l.slice('Binary files '.length, -' differ'.length)
        const name = [...unit.raw.keys()].find((k) => body.endsWith(` b/${k}`) || unquote(body.slice(body.lastIndexOf(' "') + 1)) === `b/${k}`)
        if (name) unit.files.push({ path: name, lines: [], binary: true, ...unit.raw.get(name) })
      } else if (l.startsWith('@@')) {
        hunkStart(l)
        state = 'hunk'
      }
    }
  }
  return { line, end: flush }
}

/** Feeds a readable stream through lineParser; resolves when it ends. */
export function parseGitStream(stream, onUnit) {
  const p = lineParser(onUnit)
  let rest = ''
  return new Promise((resolve, reject) => {
    stream.setEncoding('utf8')
    stream.on('data', (chunk) => {
      const text = rest + chunk
      const parts = text.split('\n')
      rest = parts.pop()
      for (const l of parts) p.line(l)
    })
    stream.on('error', reject)
    stream.on('end', () => {
      if (rest) p.line(rest)
      p.end()
      resolve()
    })
  })
}

/** Files git listed with no patch (a mode change, an empty file, a pure rename) still get their name checked. */
function withRawOnly(unit) {
  const seen = new Set(unit.files.map((f) => f.path))
  // binary 'maybe': its bytes decide (checkBlobs reads it and scans it when it holds a NUL)
  for (const [p, r] of unit.raw) if (!seen.has(p)) unit.files.push({ path: p, lines: [], binary: 'maybe', ...r })
  return unit
}

// ── Checking ────────────────────────────────────────────────────────────────

/** Line number of an offset in text whose line starts are `starts`. */
function lineAt(starts, offset) {
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (starts[mid] <= offset) lo = mid
    else hi = mid - 1
  }
  return lo
}

function snippet(text, h) {
  return text.slice(Math.max(0, h.offset - 30), h.offset + h.length + 30).replace(/\s+/g, ' ')
}

/** Every rule hit in lines [[n, text]]: [{ label, line, snip }]. */
export function scanLines(ruleSets, lines) {
  if (!lines.length) return []
  const starts = []
  let pos = 0
  const parts = []
  for (const [, t] of lines) { starts.push(pos); parts.push(t); pos += t.length + 1 }
  const text = parts.join('\n')
  const out = []
  for (const rules of ruleSets) {
    for (const h of scanText(rules, text)) {
      const k = lineAt(starts, h.offset)
      out.push({ label: h.label, line: lines[k][0], snip: snippet(text, h) })
    }
  }
  return out
}

/** The rules on a file's place and size (size 0: not known yet, checkBlobs judges it). */
export function fileRuleHits(f, size) {
  const hits = []
  const p = f.path
  if (PRIVATE_DATA.test(p) || (STORE_FILE.test(p) && !FIXTURES.test(p))) hits.push({ label: 'private-data-file', line: 0, snip: p })
  if (MEDIA.test(p) && !ASSET_DIRS.test(p) && !FIXTURE_DIR.test(p)) hits.push({ label: 'media-outside-assets', line: 0, snip: p })
  if (OPAQUE.test(p) && !ASSET_DIRS.test(p) && !FIXTURE_DIR.test(p)) hits.push({ label: 'opaque-file-outside-assets', line: 0, snip: p })
  if (size > MAX_FILE_BYTES) hits.push({ label: 'large-file', line: 0, snip: `${(size / 1048576).toFixed(1)} MB` })
  return hits
}

/** Object sizes of blobs, one `git cat-file --batch-check` for all. */
function blobSizes(repo, blobs) {
  const want = [...new Set(blobs.filter((b) => b && !ZERO.test(b)))]
  const sizes = new Map()
  if (!want.length) return sizes
  const r = spawnSync('git', ['-C', repo, 'cat-file', '--batch-check=%(objectname) %(objectsize)'], { input: want.join('\n') + '\n', encoding: 'utf8', maxBuffer: 1 << 30 })
  if (r.status !== 0) throw new Error(`git cat-file --batch-check failed: ${(r.stderr || '').trim()}`)
  for (const l of (r.stdout || '').split('\n')) {
    const [o, n] = l.split(' ')
    if (o && /^\d+$/.test(n ?? '')) sizes.set(o, Number(n))
  }
  return sizes
}

/** Streams the contents of blobs (one `git cat-file --batch`), calling onBlob(sha, buffer) for each. */
function readBlobs(repo, shas, onBlob) {
  if (!shas.length) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', repo, 'cat-file', '--batch'], { stdio: ['pipe', 'pipe', 'ignore'] })
    let buf = Buffer.alloc(0)
    let parts = [] // chunks of the object being read, joined once it is whole
    let have = 0
    let want = null // { sha, size }
    child.stdout.on('data', (chunk) => {
      if (want) { parts.push(chunk); have += chunk.length } else buf = buf.length ? Buffer.concat([buf, chunk]) : chunk
      for (;;) {
        if (!want) {
          const nl = buf.indexOf(10)
          if (nl < 0) return
          const [sha, type, size] = buf.subarray(0, nl).toString('utf8').split(' ')
          buf = buf.subarray(nl + 1)
          if (type === 'missing' || !size) continue
          want = { sha, size: Number(size) }
          parts = [buf]
          have = buf.length
          buf = Buffer.alloc(0)
        }
        if (have < want.size + 1) return
        const all = parts.length === 1 ? parts[0] : Buffer.concat(parts, have)
        onBlob(want.sha, all.subarray(0, want.size))
        buf = all.subarray(want.size + 1)
        parts = []
        have = 0
        want = null
      }
    })
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`git cat-file --batch exited ${code}`))))
    child.stdin.end(shas.join('\n') + '\n')
  })
}

function fingerprint(commit, where, label) {
  return createHash('sha256').update(`${commit ?? 'staged'}:${where}:${label}`).digest('hex').slice(0, 16)
}

function hitOf(commit, label, where, snip) {
  return { label, where: `${where}${commit ? ` (commit ${commit.slice(0, 10)})` : ''}`, snip, fp: fingerprint(commit, where, label) }
}

/**
 * The hits of one unit's text: [{ label, where, snip, fp }]. The files whose bytes must be read
 * (their size, a binary's text) go on `pending` as { commit, path, blob, binary }.
 */
export function checkUnit(unit, { ruleSets, privateRules, pending }) {
  const hits = []
  const add = (label, where, snip) => hits.push(hitOf(unit.commit, label, where, snip))
  for (const f of unit.files) {
    for (const h of scanLines(ruleSets, [[0, f.path]])) add(h.label, `${f.path} (its name)`, h.snip)
    for (const h of fileRuleHits(f, 0)) add(h.label, f.path, h.snip)
    if (f.blob && !ZERO.test(f.blob)) pending?.push({ commit: unit.commit, path: f.path, blob: f.blob, binary: f.binary })
    if (!f.binary) for (const h of scanLines(ruleSets, f.lines)) add(h.label, `${f.path}:${h.line}`, h.snip)
  }
  if (unit.message) {
    const lines = unit.message.split('\n').map((t, i) => [i + 1, t])
    for (const h of scanLines(ruleSets, lines)) add(h.label, `commit message line ${h.line}`, h.snip)
  }
  // identities: only the private rules (a work address); a contributor's own address is theirs to publish
  if (privateRules) {
    for (const [who, text] of [['author', unit.author], ['committer', unit.committer]]) {
      if (text) for (const h of scanLines([privateRules], [[0, text]])) add(h.label, `commit ${who}`, h.snip)
    }
  }
  return hits
}

/** The text of a UTF-16 file (a BOM, or every other byte NUL), else null: printable runs miss it. */
export function utf16Text(buf) {
  if (buf.length < 4) return null
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le')
  if (buf[0] === 0xfe && buf[1] === 0xff) return Buffer.from(buf.subarray(2)).swap16().toString('utf16le')
  const n = Math.min(buf.length & ~1, 4096)
  let odd = 0
  let even = 0
  for (let i = 0; i < n; i += 2) { if (buf[i + 1] === 0) odd++; if (buf[i] === 0) even++ }
  if (odd > n * 0.4 && even < n * 0.05) return buf.subarray(0, buf.length & ~1).toString('utf16le')
  if (even > n * 0.4 && odd < n * 0.05) return Buffer.from(buf.subarray(0, buf.length & ~1)).swap16().toString('utf16le')
  return null
}

/** The checks that read file bytes: a file over the size limit, and the text inside binaries. */
export async function checkBlobs(repo, pending, ruleSets) {
  const hits = []
  const sizes = blobSizes(repo, pending.map((p) => p.blob))
  const byBlob = new Map()
  for (const p of pending) {
    const size = sizes.get(p.blob) ?? 0
    if (size > MAX_FILE_BYTES) hits.push(hitOf(p.commit, 'large-file', p.path, `${(size / 1048576).toFixed(1)} MB`))
    if (p.binary && size > 0 && size <= 64 * MAX_FILE_BYTES) {
      if (!byBlob.has(p.blob)) byBlob.set(p.blob, [])
      byBlob.get(p.blob).push(p)
    }
  }
  await readBlobs(repo, [...byBlob.keys()], (sha, buf) => {
    const ps = byBlob.get(sha) ?? []
    // a file whose patch git showed was read line by line; a 'maybe' is text unless it holds a NUL
    if (ps.every((p) => p.binary === 'maybe') && !buf.includes(0)) return
    const u16 = utf16Text(buf)
    if (u16 !== null) {
      for (const h of scanLines(ruleSets, u16.split('\n').map((t, i) => [i + 1, t]))) for (const p of ps) hits.push(hitOf(p.commit, h.label, `${p.path}:${h.line} (UTF-16)`, h.snip))
      return
    }
    const runs = printableRuns(buf)
    for (const rules of ruleSets) {
      for (const h of binaryHits(rules, runs)) {
        for (const p of byBlob.get(sha) ?? []) hits.push(hitOf(p.commit, h.label, `${p.path} (binary, byte ${h.offset})`, snippet(runs.text, h)))
      }
    }
  })
  return hits
}

// ── gitleaks ────────────────────────────────────────────────────────────────

/**
 * gitleaks over the same content, with the config and ignore file of `configRev` only. It runs on
 * a bare clone that shares the repository's objects, never on the working tree: gitleaks also
 * reads a `.gitleaksignore` it finds in the folder it scans, and a working tree can hold any
 * uncommitted one. A staged change is first written as a commit object (nothing points at it)
 * and scanned as HEAD..that commit.
 */
export function runGitleaks({ repo, mode, logOpts, configRev, env = process.env }) {
  const probe = spawnSync('gitleaks', ['version'], { encoding: 'utf8' })
  if (probe.error || probe.status !== 0) return { missing: true, hits: [] }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-git-gl-'))
  try {
    let opts = logOpts
    if (mode === 'staged') {
      const tree = gitOut(repo, ['write-tree']).trim()
      const head = gitOut(repo, ['rev-parse', '-q', '--verify', 'HEAD'], { ok: true })?.trim()
      const ident = { ...process.env, GIT_AUTHOR_NAME: 'scan', GIT_AUTHOR_EMAIL: 'scan@example.invalid', GIT_COMMITTER_NAME: 'scan', GIT_COMMITTER_EMAIL: 'scan@example.invalid' }
      const c = gitOut(repo, ['commit-tree', tree, ...(head ? ['-p', head] : []), '-m', 'staged'], { env: ident }).trim()
      opts = head ? `${head}..${c}` : c
    }
    const bare = path.join(tmp, 'repo.git')
    const common = gitOut(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim()
    fs.mkdirSync(path.join(bare, 'objects', 'info'), { recursive: true })
    fs.mkdirSync(path.join(bare, 'refs'))
    fs.writeFileSync(path.join(bare, 'HEAD'), 'ref: refs/heads/none\n')
    fs.writeFileSync(path.join(bare, 'config'), '[core]\n\tbare = true\n\trepositoryformatversion = 0\n')
    const alt = [path.join(common, 'objects')]
    const theirs = path.join(common, 'objects', 'info', 'alternates')
    if (fs.existsSync(theirs)) alt.push(...fs.readFileSync(theirs, 'utf8').split('\n').filter(Boolean).map((l) => path.resolve(path.join(common, 'objects'), l)))
    fs.writeFileSync(path.join(bare, 'objects', 'info', 'alternates'), alt.join('\n') + '\n')
    // revisions as object ids (the bare clone has no refs), checked here: gitleaks scans nothing
    // and exits 0 when git cannot read its range
    const ids = opts.split('..').map((r) => (ZERO.test(r) ? null : gitOut(repo, ['rev-parse', '--verify', '--end-of-options', `${r}^{commit}`]).trim()))
    opts = ids.filter(Boolean).join('..')
    if (gitOut(bare, ['rev-list', '--count', ...opts.split(' ')], { ok: true, env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))) }) === null) {
      return { error: `the scan's copy of the repository cannot read ${opts}`, hits: [] }
    }
    const report = path.join(tmp, 'report.json')
    const args = ['git', '--no-banner', '--no-color', '--redact', '--log-level', 'error', '--report-format', 'json', '--report-path', report, '--exit-code', '3']
    const cfg = configRev && gitOut(repo, ['show', `${configRev}:.gitleaks.toml`], { ok: true })
    if (cfg) { fs.writeFileSync(path.join(tmp, 'gitleaks.toml'), cfg); args.push('--config', path.join(tmp, 'gitleaks.toml')) }
    const ign = configRev && gitOut(repo, ['show', `${configRev}:.gitleaksignore`], { ok: true })
    fs.mkdirSync(path.join(tmp, 'ign'))
    if (ign) fs.writeFileSync(path.join(tmp, 'ign', '.gitleaksignore'), ign)
    args.push('--gitleaks-ignore-path', path.join(tmp, 'ign'), `--log-opts=${opts}`, bare)
    const clean = Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith('GIT_')))
    const r = spawnSync('gitleaks', args, { encoding: 'utf8', env: clean, maxBuffer: 1 << 28, cwd: tmp })
    if (r.status !== 0 && r.status !== 3) return { error: (r.stderr || r.stdout || '').trim().split('\n').slice(-3).join(' '), hits: [] }
    const found = fs.existsSync(report) ? JSON.parse(fs.readFileSync(report, 'utf8') || '[]') : null
    if (!Array.isArray(found)) return { error: 'gitleaks wrote no report', hits: [] }
    return {
      hits: found.map((f) => ({
        label: `gitleaks:${f.RuleID}`,
        where: `${f.File}:${f.StartLine}${f.Commit && mode !== 'staged' ? ` (commit ${f.Commit.slice(0, 10)})` : ''}`,
        snip: f.Match || '',
        fp: f.Fingerprint || '',
      })),
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

// ── Running ─────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const o = { mode: null, arg: null, rules: null, rulesEnv: null, strict: false, redact: false, repo: process.cwd(), fingerprints: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--staged') o.mode = 'staged'
    else if (a === '--range') { o.mode = 'range'; o.arg = argv[++i] }
    else if (a === '--history') { o.mode = 'history'; o.arg = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'HEAD' }
    else if (a === '--message-file') { o.mode = 'message'; o.arg = argv[++i] }
    else if (a === '--text') { o.mode = 'text'; o.arg = argv[++i] }
    else if (a === '--rules') o.rules = argv[++i]
    else if (a === '--rules-env') o.rulesEnv = argv[++i]
    else if (a === '--strict') o.strict = true
    else if (a === '--redact') o.redact = true
    else if (a === '--repo') o.repo = argv[++i]
    else if (a === '--fingerprints') o.fingerprints = true
    else throw new Error(`unknown option ${a} (there is no option to skip a check)`)
  }
  if (!o.mode) throw new Error('pass --staged, --range <A>..<B>, --history [<rev>], --message-file <f> or --text <path>')
  if (o.mode !== 'staged' && o.mode !== 'history' && !o.arg) throw new Error(`--${o.mode} needs a value`)
  return o
}

/** The commit whose scanner judges this run (the base of a range, HEAD for staged), if it has one. */
function judgeRev(o) {
  if (o.mode === 'range') return o.arg.split('..')[0]
  if (o.mode === 'staged' || o.mode === 'message') return 'HEAD'
  return null
}

/**
 * Runs the judging commit's own scanner (its scripts/leak-scan: the code and the shapes) instead
 * of the files on disk, whenever that commit has one (see the header): the working tree may hold
 * the very change being judged.
 */
function reexecFromBase(o, argv) {
  // the copy this function extracted marks itself with a file beside it (no env var or option,
  // which a caller could set to keep a loosened scanner on disk)
  if (fs.existsSync(path.join(HERE, '..', '..', JUDGED_MARK))) return null
  const rev = judgeRev(o)
  if (!rev || ZERO.test(rev)) return null
  if (gitOut(o.repo, ['cat-file', '-e', `${rev}:scripts/leak-scan/scan-git.mjs`], { ok: true }) === null) return null
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-git-base-'))
  try {
    const tar = gitOut(o.repo, ['archive', '--format=tar', rev, 'scripts/leak-scan'], { buffer: true })
    fs.writeFileSync(path.join(tmp, 'x.tar'), tar)
    const x = spawnSync('tar', ['-xf', path.join(tmp, 'x.tar'), '-C', tmp])
    if (x.status !== 0 || !fs.existsSync(path.join(tmp, 'scripts/leak-scan/scan-git.mjs'))) { console.error(`scan-git: could not read the scanner of ${rev}`); return 2 }
    fs.writeFileSync(path.join(tmp, JUDGED_MARK), `${rev}\n`)
    const r = spawnSync(process.execPath, [path.join(tmp, 'scripts/leak-scan/scan-git.mjs'), ...argv, ...(argv.includes('--repo') ? [] : ['--repo', o.repo])], { stdio: 'inherit' })
    return r.status ?? 2
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

function gitStream(repo, args) {
  const child = spawn('git', ['-C', repo, '-c', 'core.quotepath=off', ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
  let err = ''
  child.stderr.on('data', (d) => { err += d })
  const done = new Promise((resolve) => child.on('close', (code) => resolve({ code, err })))
  return { stdout: child.stdout, done }
}

// fixed prefixes: diff.mnemonicPrefix / diff.noprefix / dstPrefix in a config would change them
const JUDGED_MARK = '.scan-git-judged-from'

const DIFF_OPTS = ['--no-color', '--no-ext-diff', '--no-textconv', '-U0', '--raw', '--no-abbrev', '-p', '--no-renames', '--src-prefix=a/', '--dst-prefix=b/']

export async function run(argv, { env = process.env, log = console.log, err = console.error } = {}) {
  let o
  try { o = parseArgs(argv) } catch (e) { err(`scan-git: ${e.message}`); return 2 }
  o.repo = path.resolve(o.repo)
  const again = reexecFromBase(o, argv)
  if (again !== null) return again
  const strict = isStrict(o, env)
  let ruleSets
  let privateRules = null
  try {
    ruleSets = [shapeRules()]
    const raw = findPrivate(o, o.repo, env, strict)
    if (raw) {
      privateRules = loadRules(JSON.parse(raw), { scope: 'source' })
      ruleSets.push(privateRules)
    } else if (strict) throw new Error('the private leak rules are missing (git config walnut.leakRules, ~/.config/walnut-leak/leak-rules.json or LEAK_SCAN_RULES): refusing to judge without them')
    else err('scan-git: note: no private rules here; the committed shapes and gitleaks still apply')
  } catch (e) { err(`scan-git: ${e.message}`); return 2 }
  // known history hits: only the private rules carry them (a commit cannot add its own)
  const baseline = new Set(privateRules?.baseline ?? [])

  const hits = []
  let units = 0
  const pending = []
  const ctx = { ruleSets, privateRules, pending }
  const onUnit = (u) => { units++; for (const h of checkUnit(withRawOnly(u), ctx)) hits.push(h) }
  try {
    if (o.mode === 'message') {
      // everything git may keep (a comment character or cleanup mode can keep '#' lines); not the
      // diff `commit -v` puts below the scissors line, which git always drops
      const raw = fs.readFileSync(o.arg, 'utf8')
      const cut = raw.search(/^[#;] -+ >8 -+$/m)
      const text = cut >= 0 ? raw.slice(0, cut) : raw
      onUnit({ commit: null, author: '', committer: '', message: text, files: [], raw: new Map() })
    } else if (o.mode === 'text') {
      const text = fs.readFileSync(0, 'utf8')
      onUnit({ commit: null, author: '', committer: '', message: '', files: [{ path: o.arg, lines: text.split('\n').map((t, i) => [i + 1, t]), binary: false }], raw: new Map() })
    } else {
      let args
      if (o.mode === 'staged') args = ['diff', '--cached', '--diff-filter=ACMRT', ...DIFF_OPTS, ...(gitOut(o.repo, ['rev-parse', '-q', '--verify', 'HEAD'], { ok: true }) ? ['HEAD'] : ['4b825dc642cb6eb9a060e54bf8d69288fbee4904'])]
      else {
        const rev = o.mode === 'range' && ZERO.test(o.arg.split('..')[0]) ? o.arg.split('..')[1] : o.arg
        // No --diff-filter here: on git log it drops whole COMMITS whose diff adds nothing (an
        // empty commit, a delete-only one, a commit-tree copy of its parent's tree), and their
        // author, committer and message would go unread. The parser skips deleted files itself.
        args = ['log', '--reverse', '--diff-merges=first-parent', ...DIFF_OPTS, LOG_FORMAT, rev, '--']
      }
      const s = gitStream(o.repo, args)
      await parseGitStream(s.stdout, onUnit)
      const { code, err: e } = await s.done
      if (code !== 0) throw new Error(`git ${args[0]} failed: ${e.trim().split('\n').pop()}`)
      for (const h of await checkBlobs(o.repo, pending, ruleSets)) hits.push(h)
    }
  } catch (e) { err(`scan-git: could not read what git publishes: ${e.message}`); return 2 }

  // gitleaks, over the same commits
  if (o.mode === 'staged' || o.mode === 'range' || o.mode === 'history') {
    const base = o.mode === 'range' ? o.arg.split('..')[0] : null
    const gl = runGitleaks({
      repo: o.repo,
      mode: o.mode === 'staged' ? 'staged' : 'log',
      logOpts: o.mode === 'range' ? (ZERO.test(base) ? o.arg.split('..')[1] : o.arg) : o.arg,
      configRev: o.mode === 'history' ? o.arg : judgeRev(o),
      env,
    })
    if (gl.missing) {
      if (strict) { err('scan-git: gitleaks is not installed (brew install gitleaks): refusing to judge without it'); return 2 }
      err('scan-git: note: gitleaks is not installed, so its secret rules did not run (brew install gitleaks)')
    } else if (gl.error) { err(`scan-git: gitleaks failed: ${gl.error}`); return 2 } else for (const h of gl.hits) hits.push(h)
  }

  const known = hits.filter((h) => baseline.has(h.fp))
  const fresh = hits.filter((h) => !baseline.has(h.fp))
  for (const h of fresh) {
    log(`scan-git: BLOCKED ${h.label} at ${h.where}${o.redact ? '' : `: ${JSON.stringify(h.snip)}`}`)
    if (o.fingerprints) log(`scan-git: fingerprint ${h.fp}`)
  }
  const what = { staged: 'the staged change', range: `${units} commit(s) ${o.arg}`, history: `${units} commit(s) of ${o.arg}`, message: 'the commit message', text: o.arg }[o.mode]
  const rulesNote = `${privateRules ? 'private rules, ' : ''}shapes${o.mode === 'message' || o.mode === 'text' ? '' : ', gitleaks'}`
  if (fresh.length) {
    log(`scan-git: ${fresh.length} hit(s) in ${what} (${rulesNote})${known.length ? `, plus ${known.length} known from history` : ''}. ${FIX}`)
    return 1
  }
  log(`scan-git: clean: ${what} (${rulesNote})${known.length ? `; ${known.length} hit(s) already public and listed in the baseline` : ''}`)
  return 0
}

if (import.meta.main ?? process.argv[1] === fileURLToPath(import.meta.url)) {
  run(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(`scan-git: ${e?.stack ?? e}`); process.exit(2) })
}
