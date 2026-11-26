/**
 * The one rule for git writes into a data home under a leader switch (src/lib/leader-home-gate.ts): which argv
 * writes, where it runs, and what each side refuses.
 */
import { afterAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { daemonGitWriteRefusal, gitArgvWrites, gitSubcommand, leaderHomeMarkAt, LEADER_SWITCH_MARKER_REL, readOnlyGitEnv, serverGitWriteRefusal } from '../../src/lib/leader-home-gate.js'
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

  it('fail-closed: every subcommand writes but the read ones and the read forms', () => {
    for (const w of [['mktree'], ['write-tree'], ['commit', '-m', 'x'], ['add', '-A'], ['update-ref', 'r', 's'], ['hash-object', '-w', 'f'], ['stash', 'push'], ['stash'],
      ['worktree', 'add', 'd'], ['symbolic-ref', 'HEAD', 'refs/heads/x'], ['tag', 'v1'], ['fetch'], ['gc'],
      // The review's list (round 1): writes outside the old name list.
      ['push', 'origin', 'main'], ['push', '--set-upstream', 'origin', 'x'], ['branch', 'new'], ['branch', '-D', 'old'], ['branch', '-f', 'x', 'HEAD'],
      ['config', 'user.name', 'x'], ['config', 'set', 'user.name', 'x'], ['config', '--unset', 'k'], ['remote', 'add', 'cloud', 'u'], ['remote', 'set-url', 'cloud', 'u'],
      ['reflog', 'expire', '--all'], ['pack-refs', '--all'], ['commit-graph', 'write'], ['multi-pack-index', 'write'], ['bundle', 'unbundle', 'b'], ['fast-import'],
      ['checkout-index', '-a'], ['update-server-info'], ['submodule', 'update'], ['sparse-checkout', 'set', 'x'], ['replace', 'a', 'b'], ['rerere'],
      ['apply', 'p.diff'], ['apply', '--check', '--index', 'p.diff'], ['hook', 'run', 'pre-commit'], ['format-patch', '-1'], ['frobnicate']]) {
      expect(gitArgvWrites(['git', ...w]), w.join(' ')).toBe(true)
    }
    for (const r of [['rev-parse', 'HEAD'], ['hash-object', '-t', 'tree', '/dev/null'], ['stash', 'list'], ['worktree', 'list'], ['symbolic-ref', '--short', 'HEAD'],
      ['tag', '-l'], ['tag'], ['status', '--porcelain'], ['diff', '--cached'], ['cat-file', '-p', 'x'], ['ls-files'], ['config', '--get', 'remote.cloud.url'],
      ['config', 'user.name'], ['config', '--list'], ['config', 'get', 'user.name'], ['branch'], ['branch', '--list', 'wt/*'], ['branch', '--show-current'],
      ['remote'], ['remote', '-v'], ['remote', 'get-url', 'cloud'], ['reflog'], ['reflog', 'show', 'HEAD'], ['bundle', 'verify', 'b'], ['apply', '--check', 'p.diff'],
      ['for-each-ref', 'refs/walnut'], ['log', '-1'], ['--version']]) {
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

  it('a marker that cannot be read (here: a folder where the file should be) refuses; only a missing one is none', () => {
    const h = home('unreadable')
    fs.mkdirSync(path.join(h, LEADER_SWITCH_MARKER_REL), { recursive: true })
    expect(leaderHomeMarkAt(h)).toEqual({ home: h, state: 'handed-over' })
    expect(daemonGitWriteRefusal(['git', 'write-tree'], h)).toMatch(/handed over/)
    // A file where a folder on the way should be (ENOTDIR) is no marker.
    const f = home('notdir')
    fs.writeFileSync(path.join(f, 'local'), 'a file')
    expect(leaderHomeMarkAt(f)).toBeNull()
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

describe('the read env', () => {
  it('optional locks off everywhere; in a marked home also no diff index refresh, appended to the config already given', () => {
    const free = home('env-free')
    const over = home('env-over', JSON.stringify({ state: 'handed-over' }))
    expect(readOnlyGitEnv({ PATH: '/bin' }, free)).toEqual({ PATH: '/bin', GIT_OPTIONAL_LOCKS: '0' })
    expect(readOnlyGitEnv({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.x', GIT_CONFIG_VALUE_0: 'y' }, path.join(over, 'plugins', 'p'))).toEqual({
      GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'core.x', GIT_CONFIG_VALUE_0: 'y', GIT_CONFIG_KEY_1: 'diff.autoRefreshIndex', GIT_CONFIG_VALUE_1: 'false', GIT_OPTIONAL_LOCKS: '0',
    })
  })
})
