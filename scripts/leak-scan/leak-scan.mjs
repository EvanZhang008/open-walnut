#!/usr/bin/env bun
/**
 * Public leak scan: looks for private words and shapes in anything Walnut publishes
 * (npm tarballs, release assets, the site, Actions logs, a source tree).
 * See scripts/leak-scan/README.md.
 *
 *   bun scripts/leak-scan/leak-scan.mjs (--rules <file> | --rules-env <VAR>)
 *       [--redact | --count-only] [--exclude <name>]... [--skip-ok] [--min-files <n>] <path>...
 *
 * A path is a file or a directory; .tgz/.tar.gz/.tar/.zip/.gz files are opened and their
 * contents scanned (nested up to 3 levels), and a .dmg is mounted read-only on macOS.
 * Binary files are scanned through their printable runs, as `strings` shows them. Every
 * file and directory name is scanned too.
 *
 * Output: without a flag, each hit with the text around it. --redact: the rule and the
 * place only, never the text, with any hit inside a printed path masked (a public log of
 * our own artifacts). --count-only: only how many hits there were (a public log of text
 * someone else wrote, where a place would tell them which of their words is on the list).
 *
 * Exit: 0 nothing found, 1 hits, 2 an error (no or bad rules, an input that could not be
 * read, fewer files than --min-files (default 1), or a file that could not be opened
 * unless --skip-ok).
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadRules, printableRuns, runOffset, scanText } from './core.mjs'

const CHUNK = 32 * 1024 * 1024
const OVERLAP = 4096
const MAX_DEPTH = 3

function parseArgs(argv) {
  const o = { rules: null, rulesEnv: null, mode: 'plain', skipOk: false, minFiles: 1, exclude: [], paths: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--rules') o.rules = argv[++i]
    else if (a === '--rules-env') o.rulesEnv = argv[++i]
    else if (a === '--redact') o.mode = 'redact'
    else if (a === '--count-only') o.mode = 'count'
    else if (a === '--skip-ok') o.skipOk = true
    else if (a === '--exclude') o.exclude.push(argv[++i])
    else if (a === '--min-files') {
      o.minFiles = Number(argv[++i])
      if (!Number.isInteger(o.minFiles) || o.minFiles < 0) throw new Error('--min-files takes a whole number')
    } else if (a.startsWith('--')) throw new Error(`unknown option ${a}`)
    else o.paths.push(a)
  }
  return o
}

/** Rules JSON from a file or an env var (raw JSON or base64 of it). */
export function readRules({ rules, rulesEnv }, env = process.env) {
  let raw
  if (rules) raw = fs.readFileSync(rules, 'utf8')
  else if (rulesEnv) {
    raw = env[rulesEnv]
    if (!raw || !raw.trim()) throw new Error(`no rules: ${rulesEnv} is empty or unset`)
    if (!raw.trim().startsWith('{')) raw = Buffer.from(raw.trim(), 'base64').toString('utf8')
  } else throw new Error('no rules: pass --rules <file> or --rules-env <VAR>')
  let json
  try { json = JSON.parse(raw) } catch { throw new Error('the rules are not valid JSON') }
  return loadRules(json)
}

function archiveKind(p) {
  const n = p.toLowerCase()
  if (n.endsWith('.tgz') || n.endsWith('.tar.gz')) return 'tgz'
  if (n.endsWith('.tar')) return 'tar'
  if (n.endsWith('.zip')) return 'zip'
  if (n.endsWith('.gz')) return 'gz'
  if (n.endsWith('.dmg')) return 'dmg'
  return null
}

function quietExec(cmd, args) {
  execFileSync(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], maxBuffer: 16 * 1024 * 1024 })
}

function scanFile(rules, file, shown, report) {
  const size = fs.statSync(file).size
  if (size === 0) return 0
  const fd = fs.openSync(file, 'r')
  try {
    const head = Buffer.alloc(Math.min(size, 8192))
    fs.readSync(fd, head, 0, head.length, 0)
    const binary = head.includes(0)
    for (let pos = 0; pos < size; pos += CHUNK) {
      const len = Math.min(size - pos, CHUNK + OVERLAP)
      const buf = Buffer.alloc(len)
      fs.readSync(fd, buf, 0, len, pos)
      // a hit starting in the overlap belongs to the next chunk
      const keepBelow = pos + CHUNK >= size ? Infinity : pos + CHUNK
      let text
      let hits
      if (binary) {
        const runs = printableRuns(buf)
        text = runs.text
        hits = scanText(rules, text).map((h) => ({ ...h, at: pos + runOffset(runs, h.offset) }))
      } else {
        text = buf.toString('latin1')
        hits = scanText(rules, text).map((h) => ({ ...h, at: pos + h.offset }))
      }
      for (const h of hits) if (h.at < keepBelow) report(shown, h, text)
    }
  } finally {
    fs.closeSync(fd)
  }
  return size
}

export function scanPaths(rules, inputs, { exclude = [], onHit, onSkip } = {}) {
  const stats = { files: 0, bytes: 0, hits: 0, skipped: 0, labels: new Map() }
  const report = (shown, h, text) => {
    stats.hits++
    stats.labels.set(h.label, (stats.labels.get(h.label) ?? 0) + 1)
    const snippet = h.offset < 0 ? text : text.slice(Math.max(0, h.offset - 40), h.offset + h.length + 40)
    onHit?.({ file: shown, label: h.label, offset: h.at, inName: h.offset < 0, snippet })
  }
  const skip = (shown, why) => { stats.skipped++; onSkip?.({ file: shown, why }) }
  const scanName = (shown, name) => {
    for (const h of scanText(rules, name)) report(shown, { ...h, offset: -1, at: -1 }, name)
  }

  const walk = (real, shown, name, depth) => {
    const st = fs.lstatSync(real)
    if (st.isSymbolicLink()) return
    if (name) scanName(shown, name)
    if (st.isDirectory()) {
      for (const child of fs.readdirSync(real).sort()) {
        if (exclude.includes(child)) continue
        walk(path.join(real, child), `${shown}/${child}`, child, depth)
      }
      return
    }
    if (!st.isFile()) return skip(shown, 'not a regular file')
    const kind = archiveKind(real)
    if (!kind) {
      stats.files++
      stats.bytes += scanFile(rules, real, shown, report)
      return
    }
    if (depth >= MAX_DEPTH) return skip(shown, 'archive nested too deep')
    stats.files++
    stats.bytes += st.size
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leak-scan-'))
    try {
      if (kind === 'dmg') {
        if (process.platform !== 'darwin') return skip(shown, 'a .dmg opens only on macOS')
        const mnt = path.join(dir, 'mnt')
        fs.mkdirSync(mnt)
        quietExec('hdiutil', ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mnt, real])
        try { walk(mnt, `${shown}!`, null, depth + 1) } finally { quietExec('hdiutil', ['detach', mnt, '-force']) }
      } else {
        if (kind === 'tgz' || kind === 'tar') quietExec('tar', ['-xf', real, '-C', dir])
        else if (kind === 'zip') quietExec('unzip', ['-qq', '-o', real, '-d', dir])
        else fs.writeFileSync(path.join(dir, path.basename(real).replace(/\.gz$/i, '')), execFileSync('gzip', ['-dc', real], { maxBuffer: 1 << 30 }))
        walk(dir, `${shown}!`, null, depth + 1)
      }
    } catch (e) {
      skip(shown, `could not open: ${String(e.message).split('\n')[0]}`)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }

  for (const p of inputs) walk(path.resolve(p), p, null, 0)
  return stats
}

/** A path with every rule hit inside it masked, for redacted output. */
export function maskPath(rules, p) {
  let out = p
  for (const h of scanText(rules, p)) out = out.slice(0, h.offset) + '*'.repeat(h.length) + out.slice(h.offset + h.length)
  return out
}

function main() {
  let opts
  let rules
  try {
    opts = parseArgs(process.argv.slice(2))
    if (!opts.paths.length) throw new Error('no paths to scan')
    rules = readRules(opts)
    for (const p of opts.paths) if (!fs.existsSync(p)) throw new Error(`no such path: ${opts.mode === 'plain' ? p : '(redacted)'}`)
  } catch (e) {
    console.error(`leak-scan: ${e.message}`)
    process.exit(2)
  }
  const show = (p) => (opts.mode === 'plain' ? p : maskPath(rules, p))
  const stats = scanPaths(rules, opts.paths, {
    exclude: opts.exclude,
    onHit: (h) => {
      if (opts.mode === 'count') return
      const where = h.inName ? `${show(h.file)} (its name)` : `${show(h.file)} @${h.offset}`
      console.log(opts.mode === 'redact' ? `leak-scan: HIT ${h.label} ${where}` : `leak-scan: HIT ${h.label} ${where} ${JSON.stringify(h.snippet)}`)
    },
    onSkip: (s) => { if (opts.mode !== 'count') console.log(`leak-scan: SKIPPED ${show(s.file)} (${s.why})`) },
  })
  const labels = opts.mode === 'count' ? '' : [...stats.labels].map(([l, n]) => `${l}=${n}`).join(' ')
  console.log(`leak-scan: ${stats.files} files, ${stats.bytes} bytes, ${rules.count} rules: ${stats.hits} hits${labels ? ` (${labels})` : ''}, ${stats.skipped} skipped`)
  if (stats.hits) process.exit(1)
  if (stats.files < opts.minFiles) {
    console.log(`leak-scan: only ${stats.files} files scanned, fewer than --min-files ${opts.minFiles}`)
    process.exit(2)
  }
  process.exit(stats.skipped && !opts.skipOk ? 2 : 0)
}

if (import.meta.main ?? process.argv[1] === new URL(import.meta.url).pathname) main()
