/**
 * The one rule for git writes into a data home under a leader switch (src/lib/leader-home-gate.ts): which argv
 * writes, where it runs, and what each side refuses.
 */
import { afterAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { daemonGitWriteRefusal, gitArgvWrites, gitSubcommand, leaderHomeMarkAt, LEADER_SWITCH_MARKER_REL, serverGitWriteRefusal } from '../../src/lib/leader-home-gate.js'
import { markerFile } from '../../src/core/leader/switch/records.js'

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'leader-home-gate-'))
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }))

function home(name: string, marker?: string): string {
  const dir = path.join(ROOT, name)
  fs.mkdirSync(path.join(dir, 'plugins', 'p'), { recursive: true })
  if (marker !== undefined) {
    fs.mkdirSync(path.dirname(path.join(dir, LEADER_SWITCH_MARKER_REL)), { recursive: true })
    fs.writeFileSync(path.join(dir, LEADER_SWITCH_MARKER_REL), marker)
  }
  return dir
}

describe('which git argv writes', () => {
  it('finds the subcommand past the global options', () => {
    expect(gitSubcommand(['git', '-c', 'credential.helper=', 'fetch', 'origin'])).toBe('fetch')
    expect(gitSubcommand(['-C', '/x', '--no-pager', 'commit-tree', 't'])).toBe('commit-tree')
    expect(gitSubcommand(['/usr/bin/git', 'mktree'])).toBe('mktree')
    expect(gitSubcommand(['git', '--version'])).toBeNull()
  })

  it('writers by name, the read forms not', () => {
    for (const w of [['mktree'], ['write-tree'], ['commit', '-m', 'x'], ['add', '-A'], ['update-ref', 'r', 's'], ['hash-object', '-w', 'f'], ['stash', 'push'], ['stash'], ['worktree', 'add', 'd'], ['symbolic-ref', 'HEAD', 'refs/heads/x'], ['tag', 'v1'], ['fetch'], ['gc']]) {
      expect(gitArgvWrites(['git', ...w]), w.join(' ')).toBe(true)
    }
    for (const r of [['rev-parse', 'HEAD'], ['hash-object', '-t', 'tree', '/dev/null'], ['stash', 'list'], ['worktree', 'list'], ['symbolic-ref', '--short', 'HEAD'], ['tag', '-l'], ['status'], ['diff', '--cached'], ['cat-file', '-p', 'x'], ['ls-files']]) {
      expect(gitArgvWrites(['git', ...r]), r.join(' ')).toBe(false)
    }
  })
})

describe('the marker of a data home', () => {
  it('is the one records.ts writes', () => {
    expect(markerFile('/h')).toBe(path.join('/h', LEADER_SWITCH_MARKER_REL))
  })

  it('found at the dir or above it; a torn one reads as handed over; none elsewhere', () => {
    const h = home('a', JSON.stringify({ state: 'switching' }))
    expect(leaderHomeMarkAt(h)).toEqual({ home: h, state: 'switching' })
    expect(leaderHomeMarkAt(path.join(h, 'plugins', 'p'))).toEqual({ home: h, state: 'switching' })
    expect(leaderHomeMarkAt(home('torn', '{"sta'))?.state).toBe('handed-over')
    expect(leaderHomeMarkAt(home('none'))).toBeNull()
  })

  it('a daemon refuses a writing git under either state, a server under handed-over only; reads pass; -C counts', () => {
    const switching = home('s', JSON.stringify({ state: 'switching' }))
    const over = home('o', JSON.stringify({ state: 'handed-over' }))
    const free = home('f')
    expect(daemonGitWriteRefusal(['git', 'write-tree'], switching)).toMatch(/a leader switch is taking it away/)
    expect(daemonGitWriteRefusal(['git', 'commit-tree', 't'], path.join(over, 'plugins', 'p'))).toMatch(/handed over/)
    expect(daemonGitWriteRefusal(['git', 'rev-parse', 'HEAD'], over)).toBeNull()
    expect(daemonGitWriteRefusal(['git', 'write-tree'], free)).toBeNull()
    expect(daemonGitWriteRefusal(['git', '-C', over, 'add', '-A'], free)).toMatch(/handed over/)
    expect(serverGitWriteRefusal(['commit', '-m', 'x'], switching)).toBeNull()
    expect(serverGitWriteRefusal(['commit', '-m', 'x'], over)).toMatch(/git commit refused/)
  })
})
