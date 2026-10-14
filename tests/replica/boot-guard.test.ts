/**
 * What a host replica refuses at boot (src/replica/boot-guard.ts,
 * docs/plan/walnut-replica-servers-impl.md WP1): no run dir of its own, the
 * shared /tmp/open-walnut, the host daemon's own dir, no leader id, no data dir
 * of its own, the production data dir. And the port `web --replica` takes.
 * Pure checks: nothing here creates or opens any of those dirs.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { claimReplicaDir, REPLICA_DIR_MARKER, replicaBootRefusal, tightenReplicaModes } from '../../src/replica/boot-guard.js'
import { hostReplicaPort } from '../../src/commands/web.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'replica-guard-'))
const run = path.join(tmp, 'run')
const hostd = path.join(tmp, 'hostd')
const data = path.join(tmp, 'data')
const acct = path.join(tmp, 'fake-user')
const prodHome = path.join(acct, '.open-walnut')
for (const d of [run, hostd, data, prodHome]) fs.mkdirSync(d, { recursive: true })

const good = { WALNUT_DAEMON_DIR: run, WALNUT_HOST_DAEMON_DIR: hostd, WALNUT_WALNUT_ID: 'id-acme', OPEN_WALNUT_HOME: data }
const check = (env: Record<string, string | undefined>, walnutHome = data) =>
  replicaBootRefusal({ env, walnutHome, productionHomes: [prodHome], accountHomes: [acct] })

describe('host replica boot guard', () => {
  it('boots with a run dir, a data dir and the leader id of its own', () => {
    expect(check(good)).toBeNull()
  })

  it.each([
    ['no run dir', { ...good, WALNUT_DAEMON_DIR: undefined }, /WALNUT_DAEMON_DIR is not set/],
    ['a blank run dir', { ...good, WALNUT_DAEMON_DIR: '  ' }, /WALNUT_DAEMON_DIR is not set/],
    ['the shared run dir', { ...good, WALNUT_DAEMON_DIR: '/tmp/open-walnut' }, /run dir of the Walnut that owns this machine/],
    ['the shared run dir, with a trailing slash', { ...good, WALNUT_DAEMON_DIR: '/tmp/open-walnut/' }, /run dir of the Walnut that owns this machine/],
    ['the host daemon dir', { ...good, WALNUT_DAEMON_DIR: hostd }, /equals WALNUT_HOST_DAEMON_DIR/],
    ['the host daemon dir by another spelling', { ...good, WALNUT_DAEMON_DIR: path.join(hostd, '..', 'hostd') }, /equals WALNUT_HOST_DAEMON_DIR/],
    ['no leader id', { ...good, WALNUT_WALNUT_ID: '' }, /WALNUT_WALNUT_ID is not set/],
    ['no data dir of its own', { ...good, OPEN_WALNUT_HOME: undefined }, /OPEN_WALNUT_HOME is not set/],
    ['a run dir inside the shared run dir', { ...good, WALNUT_DAEMON_DIR: '/tmp/open-walnut/replica' }, /inside or holds \/tmp\/open-walnut,/],
    ['the shared streams dir', { ...good, WALNUT_DAEMON_DIR: '/tmp/open-walnut-streams' }, /inside or holds \/tmp\/open-walnut-streams/],
    ['a run dir inside the shared streams dir', { ...good, WALNUT_DAEMON_DIR: '/tmp/open-walnut-streams/x' }, /inside or holds \/tmp\/open-walnut-streams/],
    ['a run dir that holds the shared run dir (/tmp)', { ...good, WALNUT_DAEMON_DIR: '/tmp' }, /inside or holds \/tmp\/open-walnut/],
    ['a run dir that holds the shared run dir (/)', { ...good, WALNUT_DAEMON_DIR: '/' }, /inside or holds \/tmp\/open-walnut/],
    ['a run dir inside the host daemon dir', { ...good, WALNUT_DAEMON_DIR: path.join(hostd, 'run') }, /inside or holds WALNUT_HOST_DAEMON_DIR/],
    ['a run dir that holds the host daemon dir', { ...good, WALNUT_DAEMON_DIR: tmp, OPEN_WALNUT_HOME: '/srv/marina-data' }, /inside or holds WALNUT_HOST_DAEMON_DIR/],
  ])('refuses %s', (_name, env, why) => {
    expect(check(env)).toMatch(why)
  })

  it.each([
    ['the run dir', () => run, /is, holds or sits inside WALNUT_DAEMON_DIR/],
    ['a dir inside the run dir', () => path.join(run, 'data'), /is, holds or sits inside WALNUT_DAEMON_DIR/],
    ['a dir that holds the run dir', () => tmp, /is, holds or sits inside WALNUT_DAEMON_DIR/],
    ['the host daemon dir', () => hostd, /is, holds or sits inside WALNUT_HOST_DAEMON_DIR/],
    ['a dir inside the host daemon dir', () => path.join(hostd, 'data'), /is, holds or sits inside WALNUT_HOST_DAEMON_DIR/],
    ['the shared run dir', () => '/tmp/open-walnut', /is, holds or sits inside \/tmp\/open-walnut/],
    ['a dir inside the shared streams dir', () => '/tmp/open-walnut-streams/data', /is, holds or sits inside \/tmp\/open-walnut-streams/],
  ])('refuses a data dir that is %s', (_name, dir, why) => {
    const home = dir()
    expect(check({ ...good, OPEN_WALNUT_HOME: home }, home)).toMatch(why)
  })

  it('takes a run dir and a data dir side by side under one parent (the ~/.open-walnut-host layout)', () => {
    const root = path.join(tmp, 'host-root')
    expect(check({ ...good, WALNUT_DAEMON_DIR: path.join(root, 'run'), OPEN_WALNUT_HOME: path.join(root, 'data') }, path.join(root, 'data'))).toBeNull()
    // Not made on disk yet: still compared by where they would be.
    expect(fs.existsSync(root)).toBe(false)
  })

  it.each([
    ['the run dir inside ~/.open-walnut', { WALNUT_DAEMON_DIR: path.join(prodHome, 'tmp') }, /WALNUT_DAEMON_DIR \S+ is, holds or sits inside \S+, the production Walnut's data dir/],
    ['the run dir equal to ~/.open-walnut', { WALNUT_DAEMON_DIR: prodHome }, /WALNUT_DAEMON_DIR \S+ is, holds or sits inside \S+, the production Walnut's data dir/],
    ['the run dir equal to the account home', { WALNUT_DAEMON_DIR: acct }, /WALNUT_DAEMON_DIR \S+ is, holds or sits inside \S+, the production Walnut's data dir/],
    ['the data dir inside ~/.open-walnut', { OPEN_WALNUT_HOME: path.join(prodHome, 'acme') }, /the data dir \S+ is, holds or sits inside \S+, the production Walnut's data dir/],
    ['the data dir holding the account home', { OPEN_WALNUT_HOME: tmp, WALNUT_DAEMON_DIR: '/srv/marina-run', WALNUT_HOST_DAEMON_DIR: '/srv/marina-hostd' }, /the data dir \S+ is, holds or sits inside \S+, the production Walnut's data dir/],
  ])('refuses %s', (_name, over, why) => {
    const env = { ...good, ...over }
    expect(check(env, env.OPEN_WALNUT_HOME)).toMatch(why)
  })

  it('refuses a dir that is or holds the account home even with no production Walnut there', () => {
    const lone = path.join(tmp, 'lone', 'marina')
    const at = (env: Record<string, string | undefined>) => replicaBootRefusal({ env, walnutHome: env.OPEN_WALNUT_HOME!, productionHomes: [prodHome], accountHomes: [lone] })
    expect(at({ ...good, OPEN_WALNUT_HOME: lone })).toMatch(/the data dir \S+ is or holds the account's home/)
    expect(at({ ...good, OPEN_WALNUT_HOME: path.dirname(lone) })).toMatch(/the data dir \S+ is or holds the account's home/)
    expect(at({ ...good, WALNUT_DAEMON_DIR: lone })).toMatch(/WALNUT_DAEMON_DIR \S+ is or holds the account's home/)
    // The normal layout sits inside the home: ~/.open-walnut-host/{data,run}.
    const hostRoot = path.join(lone, '.open-walnut-host')
    expect(at({ ...good, OPEN_WALNUT_HOME: path.join(hostRoot, 'data'), WALNUT_DAEMON_DIR: path.join(hostRoot, 'run') })).toBeNull()
  })

  it('takes the default homes from the env: a data dir equal to $HOME is refused', () => {
    const fakeHome = path.join(tmp, 'env-home')
    const r = replicaBootRefusal({ env: { ...good, HOME: fakeHome, OPEN_WALNUT_HOME: fakeHome }, walnutHome: fakeHome, productionHomes: [prodHome] })
    expect(r).toMatch(/is or holds the account's home/)
  })

  it('refuses the production data dir (~/.open-walnut), also by another spelling', () => {
    expect(check({ ...good, OPEN_WALNUT_HOME: prodHome }, prodHome)).toMatch(/production Walnut's own/)
    expect(check({ ...good, OPEN_WALNUT_HOME: prodHome }, path.join(prodHome, '..', '.open-walnut'))).toMatch(/production Walnut's own/)
  })
})

describe('owner-only modes on what a host replica keeps', () => {
  it('makes a copy file left 0644 and a dir left 0755 owner-only, and never follows a symlink', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'replica-modes-'))
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'replica-outside-'))
    try {
      // The replica made this data dir: it was empty when it claimed it.
      expect(claimReplicaDir(path.join(root, 'data'))).toBe(true)
      const cache = path.join(root, 'data', 'cache')
      fs.mkdirSync(cache, { recursive: true, mode: 0o755 })
      fs.chmodSync(path.join(root, 'data'), 0o755)
      fs.chmodSync(cache, 0o755)
      const copy = path.join(cache, 'search-replica.sqlite')
      fs.writeFileSync(copy, 'x', { mode: 0o644 })
      fs.chmodSync(copy, 0o644)
      const theirs = path.join(outside, 'notes.md')
      fs.writeFileSync(theirs, 'y')
      fs.chmodSync(theirs, 0o644)
      fs.symlinkSync(theirs, path.join(cache, 'link.md'))
      expect(tightenReplicaModes([path.join(root, 'data')])).toEqual({ dirs: 2, files: 1 })
      const mode = (p: string) => fs.statSync(p).mode & 0o777
      expect([mode(path.join(root, 'data')), mode(cache), mode(copy)]).toEqual([0o700, 0o700, 0o600])
      expect(mode(theirs)).toBe(0o644)
      // Nothing left to repair: a second pass changes nothing.
      expect(tightenReplicaModes([path.join(root, 'data')])).toEqual({ dirs: 0, files: 0 })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  it('claims a dir it makes or finds empty, never one that holds anything else, and repairs only claimed dirs', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'replica-claim-'))
    const mode = (p: string) => fs.statSync(p).mode & 0o777
    try {
      const fresh = path.join(root, 'a', 'data')
      expect(claimReplicaDir(fresh)).toBe(true)
      expect(mode(fresh)).toBe(0o700)
      expect(mode(path.join(fresh, REPLICA_DIR_MARKER))).toBe(0o600)
      // Claimed again on the next boot by its marker, with files in it now.
      fs.writeFileSync(path.join(fresh, 'tasks.sqlite'), 'x')
      fs.chmodSync(path.join(fresh, 'tasks.sqlite'), 0o644)
      expect(claimReplicaDir(fresh)).toBe(true)
      // A tree the spec merely pointed at (a home, ~/.ssh, a project): left as it is.
      const theirs = path.join(root, 'theirs')
      fs.mkdirSync(path.join(theirs, 'sub'), { recursive: true })
      fs.chmodSync(theirs, 0o755)
      fs.chmodSync(path.join(theirs, 'sub'), 0o755)
      fs.writeFileSync(path.join(theirs, 'id_acme.pub'), 'k')
      fs.chmodSync(path.join(theirs, 'id_acme.pub'), 0o644)
      expect(claimReplicaDir(theirs)).toBe(false)
      expect(fs.existsSync(path.join(theirs, REPLICA_DIR_MARKER))).toBe(false)
      expect(tightenReplicaModes([theirs, fresh])).toEqual({ dirs: 0, files: 1 })
      expect([mode(theirs), mode(path.join(theirs, 'sub')), mode(path.join(theirs, 'id_acme.pub'))]).toEqual([0o755, 0o755, 0o644])
      expect(mode(path.join(fresh, 'tasks.sqlite'))).toBe(0o600)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('the port web --replica listens on', () => {
  it('takes the spec port, else an explicit one, never 3456 and never none', () => {
    expect(hostReplicaPort({ WALNUT_HOST_SERVER_PORT: '43123' }, undefined)).toBe(43123)
    expect(hostReplicaPort({ WALNUT_HOST_SERVER_PORT: '43123' }, '9999')).toBe(43123)
    expect(hostReplicaPort({}, '9999')).toBe(9999)
    expect(() => hostReplicaPort({}, undefined)).toThrow(/needs WALNUT_HOST_SERVER_PORT/)
    expect(() => hostReplicaPort({ WALNUT_HOST_SERVER_PORT: '3456' }, undefined)).toThrow(/never listens on 3456/)
    expect(() => hostReplicaPort({}, '3456')).toThrow(/never listens on 3456/)
    expect(() => hostReplicaPort({ WALNUT_HOST_SERVER_PORT: '0' }, undefined)).toThrow(/needs/)
    expect(() => hostReplicaPort({ WALNUT_HOST_SERVER_PORT: '70000' }, undefined)).toThrow(/needs/)
  })
})
