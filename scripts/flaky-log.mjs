#!/usr/bin/env bun
/**
 * The flaky-test record: every test that failed and then passed when its file ran again alone
 * is written down, and a file that did so twice within a week fails the gate until it is fixed
 * or removed (2026-11-09, the user on tests that pass and fail at random: "这种测试我们能不能废啊？
 * 把这个 test 把搞成 more reliable 啊？"). A second chance hides a flaky test; this keeps it seen.
 *
 * A file counts as fixed once it changed after its flakes (a commit touched the test file, or it
 * is gone). A fix that lives only in src/ clears it with `clear`, which records who and why.
 *
 *   bun scripts/flaky-log.mjs record <source> <key>...     add flakes ("<file> :: <test>")
 *   bun scripts/flaky-log.mjs check [<file>...]             exit 1 naming each file flaky twice in a week
 *   bun scripts/flaky-log.mjs gate <source> [<key>...]      record, then check every file (keys may come on stdin)
 *   bun scripts/flaky-log.mjs clear <file> <reason>         a fix outside the test file
 *   bun scripts/flaky-log.mjs list                          the record of the last week
 *
 * The record is one JSON line per event in WALNUT_FLAKY_LOG (default
 * ~/.cache/walnut-flaky/flaky.jsonl): the machine that gates pushes keeps the team's memory.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const WINDOW_DAYS = 7
export const REPEATS = 2
const DAY = 24 * 60 * 60 * 1000

export const logPath = () => process.env.WALNUT_FLAKY_LOG || path.join(os.homedir(), '.cache', 'walnut-flaky', 'flaky.jsonl')
const fileOf = (key) => (key.includes(' :: ') ? key.slice(0, key.indexOf(' :: ')) : key).trim()

export function readLog(file = logPath()) {
  let text = ''
  try { text = fs.readFileSync(file, 'utf8') } catch { return [] }
  return text.split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)] } catch { return [] } })
}

export function record(keys, source, { file = logPath(), now = Date.now() } = {}) {
  const rows = keys.map((k) => k.trim()).filter(Boolean).map((key) => ({ at: new Date(now).toISOString(), kind: 'flaky', file: fileOf(key), key, source }))
  if (!rows.length) return rows
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, rows.map((r) => `${JSON.stringify(r)}\n`).join(''))
  return rows
}

export function clear(testFile, reason, { file = logPath(), now = Date.now(), by = process.env.WALNUT_TASK_ID || os.userInfo().username } = {}) {
  if (!reason || reason.trim().length < 10) throw new Error('a clear needs a reason of 10 characters or more: what fixed it')
  const row = { at: new Date(now).toISOString(), kind: 'clear', file: testFile, reason: reason.trim(), by }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`)
  return row
}

/**
 * When the test file last changed in git (ms), or null when git does not know it; 'gone' when it
 * no longer exists. Read in the checkout the run is in (the cwd: a gate and the runners run at the
 * repository's root).
 */
function changedAt(testFile) {
  if (!fs.existsSync(path.join(process.cwd(), testFile))) return 'gone'
  try {
    const s = execFileSync('git', ['log', '-1', '--format=%ct', '--', testFile], { cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    return s ? Number(s) * 1000 : null
  } catch { return null }
}

/**
 * The files that flaked in REPEATS runs within WINDOW_DAYS and were not fixed since: each with its
 * flakes. A flake older than the file's last change, or than a clear of it, no longer counts.
 */
export function offenders(rows = readLog(), { now = Date.now(), only = null, lastChange = changedAt, gateOnly = false } = {}) {
  const since = now - WINDOW_DAYS * DAY
  const byFile = new Map()
  for (const r of rows) {
    if (!r?.file || (only && !only.has(r.file))) continue
    if (gateOnly && r.kind !== 'clear' && isLocalRun(r)) continue
    if (!byFile.has(r.file)) byFile.set(r.file, { flakes: [], clearedAt: 0 })
    const e = byFile.get(r.file)
    const at = Date.parse(r.at)
    if (r.kind === 'clear') e.clearedAt = Math.max(e.clearedAt, at)
    else if (at >= since) e.flakes.push(r)
  }
  const out = []
  for (const [file, e] of byFile) {
    const changed = lastChange(file)
    if (changed === 'gone') continue
    const fresh = e.flakes.filter((r) => Date.parse(r.at) > Math.max(e.clearedAt, changed ?? 0))
    // Runs, not rows: one run writes a row per flaky test under one time, and two tests of one file
    // flaking in a single run are one flake of that file (2026-11-10: three files each flaked in one
    // local run, counted twice, and the gate refused five lands whose tiers had all passed).
    const runs = new Set(fresh.map((r) => `${r.source}|${r.at}`))
    if (runs.size >= REPEATS) out.push({ file, flakes: fresh })
  }
  return out.sort((a, b) => a.file.localeCompare(b.file))
}

/**
 * A run on a person's or a task's own machine (test-layers local or land): its tree is that task's
 * clone with its unlanded changes, often on a Mac the load watchdog pauses, so the gate, which judges
 * on GitHub's runners, does not count it against everyone's push (2026-11-10: two local runs of one
 * task's clone refused every land). Local runs still read every row for their own files.
 */
export const isLocalRun = (r) => typeof r?.source === 'string' && r.source.startsWith('test-layers ')

export function offenderText(list) {
  return [
    `✗ ${list.length} test file(s) failed and then passed alone ${REPEATS} or more times in ${WINDOW_DAYS} days: a test that passes and fails at random hides real failures.`,
    ...list.flatMap(({ file, flakes }) => [`    ${file}`, ...flakes.slice(-3).map((r) => `        ${r.at} ${r.source}: ${r.key.slice(file.length + 4) || r.key}`)]),
    'Make it deterministic (no fixed sleeps or timing asserts, fake timers, wait on the real event), or delete it where',
    'another test covers the same thing. A change to the file clears it; a fix in src/ only: bun scripts/flaky-log.mjs clear <file> "<what fixed it>".',
  ].join('\n')
}

function main(argv) {
  const [cmd, ...rest] = argv
  const stdinKeys = () => { try { return fs.readFileSync(0, 'utf8').split('\n') } catch { return [] } }
  if (cmd === 'record') { record(rest.slice(1), rest[0] || 'unknown'); return 0 }
  if (cmd === 'clear') { clear(rest[0], rest.slice(1).join(' ')); return 0 }
  if (cmd === 'list') { for (const r of readLog().filter((r) => Date.parse(r.at) >= Date.now() - WINDOW_DAYS * DAY)) console.log(JSON.stringify(r)); return 0 }
  if (cmd === 'check' || cmd === 'gate') {
    const only = cmd === 'check' && rest.length ? new Set(rest) : null
    if (cmd === 'gate') {
      const keys = [...rest.slice(1), ...(rest.length > 1 || process.stdin.isTTY ? [] : stdinKeys())].filter((k) => k.trim())
      record(keys, rest[0] || 'gate')
    }
    const list = offenders(readLog(), { only, gateOnly: cmd === 'gate' })
    if (!list.length) return 0
    console.log(offenderText(list))
    return 1
  }
  console.error('usage: bun scripts/flaky-log.mjs record|check|gate|clear|list …')
  return 2
}

if (import.meta.main) process.exit(main(process.argv.slice(2)))
