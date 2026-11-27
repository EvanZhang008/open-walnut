/**
 * The session daemon's runtime can share the web server's loop (experiment in_process_daemon), so a
 * pass over a directory on one of its clocks never lists or stats through the sync fs: 2026-11-27,
 * the hourly scratch prune (pruneDaemonScratch) walked the picture tree with readdirSync/lstatSync
 * and held the Mac server's loop 1.1 to 1.8 s every hour after each start.
 *
 * Two ratchets:
 *   1. The clock passes that walk a dir that grows with data have no sync listing or stat in their
 *      bodies: they go through fs.promises in bounded batches (daemon-core.ts eachInBatches).
 *   2. Every sync dir listing (readdirSync/opendirSync) in the daemon's files is counted per file,
 *      with why it may stay. A new one fails here: when it runs on a clock over a dir that grows,
 *      make it async with eachInBatches instead of raising a number.
 */
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '../..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

/** The body of `function <name>(` in `text`: past its matched parameter list, braces matched (these bodies have no stray braces in strings). */
function bodyOf(text: string, name: string): string {
  const at = text.search(new RegExp(`function ${name}\\b[^(]*\\(`))
  if (at < 0) throw new Error(`function ${name} not found`)
  let i = text.indexOf('(', at)
  for (let parens = 0; i < text.length; i++) {
    if (text[i] === '(') parens++
    else if (text[i] === ')' && --parens === 0) break
  }
  const open = text.indexOf('{', i)
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}' && --depth === 0) return text.slice(open, i + 1)
  }
  throw new Error(`function ${name} has no end`)
}

/** Clock passes over a dir that grows with data: [file, function, its clock and dir]. */
const CLOCK_PASSES: Array<[string, string, string]> = [
  ['src/providers/daemon-core.ts', 'pruneDaemonScratch', 'runtimeKeepTimer (1 h): images/ and <dir>-images/'],
  ['src/providers/daemon-core.ts', 'scratchPass', 'runtimeKeepTimer (1 h): images/ and <dir>-images/'],
  ['src/providers/daemon-core.ts', 'eachInBatches', 'the batches every pass below runs in'],
  ['src/providers/daemon-standalone.ts', 'sweepDeadStreams', 'dead-stream retention (1 h): the streams dir, 90 days of sessions'],
  ['src/providers/daemon-standalone.ts', 'sweepDeadStreamsPass', 'dead-stream retention (1 h): the streams dir'],
  ['src/providers/daemon-stream-compaction.ts', 'compactIdleStreams', 'stream compaction (10 min): the streams dir'],
]

const SYNC_WALK = /\b(readdirSync|opendirSync|lstatSync|statSync)\(/g

describe('daemon clock passes never walk a dir with the sync fs', () => {
  it.each(CLOCK_PASSES)('%s %s (%s)', (file, name) => {
    const found = bodyOf(read(file), name).match(SYNC_WALK) ?? []
    expect(found, `${file} ${name} lists or stats with the sync fs on a daemon clock: use fs.promises through eachInBatches (daemon-core.ts)`).toEqual([])
  })
})

/**
 * Sync dir listings in the daemon's files, per file, and why each may stay. Lower a number when a
 * site goes; never raise one for a listing that runs on a clock over a dir that grows with data.
 */
const LISTING_BASELINE: Record<string, { count: number; why: string }> = {
  'src/providers/daemon-core.ts': { count: 3, why: 'keepRuntimeFiles (1 h, its io type and its call): the top level of the daemon dir and bin/, names only, then utimes on a fixed handful; the startup FIFO sweep' },
  'src/providers/daemon-standalone.ts': { count: 5, why: 'startup only: owner-only storage (2), the legacy streams move, the shim reap; daemonPorts list per command' },
  'src/providers/daemon-agent-subs.ts': { count: 1, why: 'per subscription (10 s): one session\'s subagents dir, names only' },
  'src/providers/daemon-idle-scan.ts': { count: 1, why: 'startup: the orphaned process groups' },
  'src/providers/daemon-process-groups.ts': { count: 1, why: 'shutdown: /proc on Linux' },
  'src/providers/daemon-session-state.ts': { count: 2, why: 'per command: readHistory, list' },
  'src/providers/daemon-skills.ts': { count: 2, why: 'per command: skills.sync' },
  'src/providers/daemon-spawn-journal.ts': { count: 1, why: 'startup: the spawn journal backfill' },
  'src/providers/daemon-trigger-store.ts': { count: 1, why: 'startup and triggers.configure: the trigger state files' },
  'src/providers/daemon-version-check.ts': { count: 1, why: 'the server\'s pre-listen guard, not the runtime' },
  'src/providers/daemon-version-resolve.ts': { count: 1, why: 'the server\'s connection, not the runtime' },
  'src/providers/stream-compact-core.ts': { count: 1, why: 'sweepStale\'s own listing, when its caller passes none (the daemon\'s sweep passes its async listing)' },
  'src/providers/cli-argv-files-core.ts': { count: 4, why: 'the argv sweep (1 h, after ps): argv and hook files of the last day\'s sessions' },
  'src/providers/plugin-jobs-core.ts': { count: 2, why: 'the plugin jobs prune (6 h): bundles and run dirs, bounded by the configured jobs' },
  'src/providers/plugin-job-door.ts': { count: 1, why: 'the plugin jobs prune (6 h): the run sockets of the configured jobs' },
}

function listingCounts(): Map<string, number> {
  const out = execFileSync('git', ['grep', '-cE', '(^|[^[:alnum:]_$])(readdirSync|opendirSync)\\(', '--', 'src/providers/daemon-*.ts', ...Object.keys(LISTING_BASELINE)], { cwd: ROOT, encoding: 'utf8' })
  const counts = new Map<string, number>()
  for (const line of out.split('\n')) {
    if (!line) continue
    const at = line.lastIndexOf(':')
    counts.set(line.slice(0, at), Number(line.slice(at + 1)))
  }
  return counts
}

describe('daemon sync dir listings ratchet', () => {
  it('every sync dir listing in the daemon\'s files is counted, and only tightens', () => {
    const counts = listingCounts()
    const wrong: string[] = []
    for (const [file, count] of counts) {
      const allowed = LISTING_BASELINE[file]?.count ?? 0
      if (count > allowed) wrong.push(`${file}: ${count} sync dir listing(s), baseline ${allowed}. A listing on a daemon clock over a dir that grows goes async through eachInBatches (daemon-core.ts); one that runs only at startup or per command is added here with why.`)
    }
    for (const [file, { count }] of Object.entries(LISTING_BASELINE)) {
      const actual = counts.get(file) ?? 0
      if (actual < count) wrong.push(`${file}: baseline ${count} but ${actual} remain: lower it to ${actual}.`)
    }
    expect(wrong, wrong.join('\n')).toEqual([])
  })
})
