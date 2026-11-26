/**
 * The one rule for git writes into a data home under a leader switch (src/lib/leader-home-gate.ts): which argv
 * writes, where it runs, and what each side refuses.
 */
import { afterAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { daemonGitWriteRefusal, gitArgvWrites, gitSubcommand, handedOverHomeAt, homeHandedOverRefusal, leaderHomeMarkAt, LEADER_SWITCH_MARKER_REL, readOnlyGitEnv, serverGitWriteRefusal } from '../../src/lib/leader-home-gate.js'
import { markerFile } from '../../src/core/leader/switch/records.js'
import { gitChildEnv } from '../../src/lib/git-env.js'
import { handedOverMarkerFile } from '../../src/core/handed-over-console.js'

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
  it('is the one records.ts writes and the handed-over console reads', () => {
    expect(markerFile('/h')).toBe(path.join('/h', LEADER_SWITCH_MARKER_REL))
    expect(handedOverMarkerFile('/h')).toBe(markerFile('/h'))
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

describe('the session spawn guard (handedOverHomeAt)', () => {
  it('finds the home at the real path of the cwd or above it, with the state and the machine it went to', async () => {
    const h = fs.realpathSync(home('g-switching', JSON.stringify({ switchId: 's1', state: 'switching', to: 'machine-b', at: 'now' })))
    expect(await handedOverHomeAt(h)).toEqual({ home: h, state: 'switching', to: 'machine-b' })
    expect(await handedOverHomeAt(path.join(h, 'plugins', 'p'))).toEqual({ home: h, state: 'switching', to: 'machine-b' })
    const over = fs.realpathSync(home('g-over', JSON.stringify({ state: 'handed-over', to: 'machine-c' })))
    expect(await handedOverHomeAt(over)).toEqual({ home: over, state: 'handed-over', to: 'machine-c' })
    // The sync walk of the git rule reads the same mark.
    expect(leaderHomeMarkAt(over)).toEqual({ home: over, state: 'handed-over', to: 'machine-c' })
    // A link into the home is followed: the folder decides, not the path it was named by.
    const link = path.join(ROOT, 'g-link')
    fs.symlinkSync(path.join(h, 'plugins'), link)
    expect(await handedOverHomeAt(path.join(link, 'p'))).toEqual({ home: h, state: 'switching', to: 'machine-b' })
  })

  it('by folder: a neighbour whose name starts with the home is not in it', async () => {
    const h = home('g-nb', JSON.stringify({ state: 'handed-over', to: 'm' }))
    const neighbour = h + '-c'
    fs.mkdirSync(path.join(neighbour, 'x'), { recursive: true })
    expect(await handedOverHomeAt(neighbour)).toBeNull()
    expect(await handedOverHomeAt(path.join(neighbour, 'x'))).toBeNull()
    expect(await handedOverHomeAt(home('g-none'))).toBeNull()
  })

  it('fail closed: a torn marker or one that cannot be opened marks the home as handed over, with no machine', async () => {
    const torn = fs.realpathSync(home('g-torn', '{"state":"swi'))
    expect(await handedOverHomeAt(torn)).toEqual({ home: torn, state: 'handed-over' })
    const unreadable = fs.realpathSync(home('g-unreadable'))
    fs.mkdirSync(path.join(unreadable, LEADER_SWITCH_MARKER_REL), { recursive: true })
    expect(await handedOverHomeAt(unreadable)).toEqual({ home: unreadable, state: 'handed-over' })
    // A file where a folder on the way should be (ENOTDIR) is no marker.
    const f = home('g-notdir')
    fs.writeFileSync(path.join(f, 'local'), 'a file')
    expect(await handedOverHomeAt(f)).toBeNull()
  })

  it('a cwd that does not resolve is walked as given', async () => {
    const h = fs.realpathSync(home('g-gone', JSON.stringify({ state: 'switching', to: 'm2' })))
    expect(await handedOverHomeAt(path.join(h, 'no', 'such', 'dir'))).toEqual({ home: h, state: 'switching', to: 'm2' })
  })

  it('a refusal names the home, the state and the machine, as fields the server shows', () => {
    expect(homeHandedOverRefusal('start', { home: '/h', state: 'switching', to: 'mb' })).toEqual({
      error: expect.stringMatching(/^start: refused, .*\/h .*a leader switch is moving it to machine mb/),
      code: 'HOME_HANDED_OVER', errorKind: 'home_handed_over', reason: 'home_handed_over', home: '/h', state: 'switching', to: 'mb',
    })
    const torn = homeHandedOverRefusal('acpStart', { home: '/h', state: 'handed-over' })
    expect(torn).not.toHaveProperty('to')
    expect(torn.error).toMatch(/it was handed over \(/)
  })
})

describe('the read env', () => {
  it('only in a marked home: optional locks off and no diff index refresh, appended to the config already given', () => {
    const free = home('env-free')
    const over = home('env-over', JSON.stringify({ state: 'handed-over' }))
    const switching = home('env-switching', JSON.stringify({ state: 'switching' }))
    // Unmarked, or no cwd: the env comes back as given (2026-11-26: optional locks off everywhere made every status
    // of a touched 20 GB home hash it all again, 98 to 131 s a run).
    expect(readOnlyGitEnv({ LANG: 'C' }, free)).toEqual({ LANG: 'C' })
    expect(readOnlyGitEnv({ LANG: 'C' }, '')).toEqual({ LANG: 'C' })
    expect(readOnlyGitEnv({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.x', GIT_CONFIG_VALUE_0: 'y' }, path.join(over, 'plugins', 'p'))).toEqual({
      GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'core.x', GIT_CONFIG_VALUE_0: 'y', GIT_CONFIG_KEY_1: 'diff.autoRefreshIndex', GIT_CONFIG_VALUE_1: 'false', GIT_OPTIONAL_LOCKS: '0',
    })
    expect(readOnlyGitEnv({}, switching)).toEqual({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'diff.autoRefreshIndex', GIT_CONFIG_VALUE_0: 'false', GIT_OPTIONAL_LOCKS: '0' })
  })

  it('gitChildEnv adds it only with a cwd in a marked home, and there no caller\'s env turns it back on', () => {
    const free = home('child-free')
    const over = home('child-over', JSON.stringify({ state: 'handed-over' }))
    const base = { LANG: 'C', GIT_DIR: '/inherited' }
    expect(gitChildEnv(undefined, base)).toEqual({ LANG: 'C' })
    expect(gitChildEnv(undefined, base, free)).toEqual({ LANG: 'C' })
    expect(gitChildEnv({ GIT_TERMINAL_PROMPT: '0' }, base, free)).toEqual({ LANG: 'C', GIT_TERMINAL_PROMPT: '0' })
    expect(gitChildEnv({ GIT_OPTIONAL_LOCKS: '1' }, base, over)).toEqual({
      LANG: 'C', GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'diff.autoRefreshIndex', GIT_CONFIG_VALUE_0: 'false',
    })
  })
})
