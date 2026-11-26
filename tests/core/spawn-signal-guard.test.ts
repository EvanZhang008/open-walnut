/**
 * An e2e test never waits on a session record's `pid` as its "it spawned" signal.
 *
 * A plain mock turn exits at its result and the runner clears the record's pid then,
 * so a poll for a truthy pid races the turn: since a40f8c7193 the mock daemon answers a
 * start only once its first line went in, the turn often ended before the first poll,
 * and quick-start-walnut-agent and mobile-launch-ask timed out on CI (2026-11-26). The
 * spawn's lasting facts are the daemon's start args and the record fields its persist
 * writes (tests/helpers/spawned-cli-model.ts).
 *
 * The scan finds every poll (`vi.waitFor`, `expect.poll`, `pollUntil`) in
 * tests/e2e/**\/*.test.ts whose body reads a session record and asserts its `pid`.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const REPO = path.resolve(__dirname, '../..')

/** The text of the call whose `(` is at `open`, brackets balanced (strings skipped). */
function callBody(text: string, open: number): string {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    const c = text[i]
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1
      while (j < text.length && text[j] !== c) j += text[j] === '\\' ? 2 : 1
      i = j
      continue
    }
    if (c === '(') depth++
    else if (c === ')' && --depth === 0) return text.slice(open + 1, i)
  }
  return text.slice(open + 1)
}

const READS_RECORD = /\b(?:getSessionByClaudeId|getSessionsForTask|getSessionRecord|getSessionByTaskId|listSessions)\s*\(/
const ASSERTS_PID = /\.pid\s*\)\s*\.(?:not\.)?(?:toBeTruthy|toBeDefined|toBeGreaterThan|toBe\b)/

/** Lines of polls in one file's text that wait on a session record's pid. */
export function pidPolls(text: string): number[] {
  const out: number[] = []
  for (const m of text.matchAll(/\b(?:vi\.waitFor|expect\.poll|pollUntil)\s*\(/g)) {
    const body = callBody(text, m.index + m[0].length - 1)
    if (READS_RECORD.test(body) && ASSERTS_PID.test(body)) out.push(text.slice(0, m.index).split('\n').length)
  }
  return out
}

function e2eTestFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.test.ts')) out.push(path.relative(REPO, full).split(path.sep).join('/'))
    }
  }
  walk(path.join(REPO, 'tests/e2e'))
  return out.sort()
}

describe('e2e spawn signals', () => {
  it('finds the shapes a test writes', () => {
    expect(pidPolls([
      'await vi.waitFor(async () => {',
      '  const record = await getSessionByClaudeId(sid)',
      '  expect(record!.pid).toBeTruthy()',
      '})',
    ].join('\n'))).toEqual([1])
    expect(pidPolls('await vi.waitFor(async () => expect((await getSessionByClaudeId(sid))?.pid).toBeGreaterThan(0))')).toEqual([1])
    expect(pidPolls('await expect.poll(async () => (await getSessionsForTask(id))[0].pid).toBeTruthy()')).toEqual([])
    // A lasting field, or a pid read once outside any poll, is not a race on the turn.
    expect(pidPolls('await vi.waitFor(async () => expect((await getSessionByClaudeId(sid))?.outputFile).toBeTruthy())')).toEqual([])
    expect(pidPolls('const records = await getSessionsForTask(id)\nexpect(records[0].pid).toBeGreaterThan(1)')).toEqual([])
  })

  it('no e2e poll waits on a session record\'s pid', () => {
    const offenders: string[] = []
    for (const file of e2eTestFiles()) {
      for (const line of pidPolls(fs.readFileSync(path.join(REPO, file), 'utf8'))) offenders.push(`${file}:${line}`)
    }
    expect(offenders, 'a one-turn session clears its pid when it exits: wait on the daemon\'s start and a field '
      + 'the spawn persists (tests/helpers/spawned-cli-model.ts)').toEqual([])
  })
})
