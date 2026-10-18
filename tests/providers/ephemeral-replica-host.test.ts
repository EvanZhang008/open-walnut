/**
 * WALNUT_EPHEMERAL_REPLICA_HOST (src/providers/ephemeral-replica-host.ts, WP14,
 * docs/plan/walnut-replica-servers-impl.md section 13 step 2): the one host an
 * ephemeral server may lead, for the replica check on a real dev box.
 *
 * Invariants:
 *   - read only is lifted for the named alias ONLY; every other host stays read only;
 *   - only when the host's isolated daemon dir is not a production dir
 *     (/tmp/open-walnut, ~/.cache/open-walnut, ~/.open-walnut, or inside one);
 *   - only for a host reached over ssh (never the companion's box), and only with an
 *     isolated host server root (never the production replica's ~/.open-walnut-host);
 *   - a refusal says why in the log, and the host stays read only;
 *   - a lifted host uses its isolated dir and that dir's own streams dir,
 *     never the dir its probe would choose.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-eph-replica-test', { IS_EPHEMERAL: true }))

import { DaemonConnection } from '../../src/providers/daemon-connection.js'
import { ephemeralReplicaHost, isProdDaemonDir, isProdHostRoot } from '../../src/providers/ephemeral-replica-host.js'
import { log } from '../../src/logging/index.js'
import type { SshTarget } from '../../src/providers/session-io.js'

const TARGET: SshTarget = { hostname: 'devbox.example.test', user: 'marina', use_daemon: true }
const ISOLATED = '/tmp/walnut-replica-check/run'
const EPH_ROOT = '$HOME/.open-walnut-host-eph'
const KEYS = ['WALNUT_EPHEMERAL_REPLICA_HOST', 'WALNUT_EPHEMERAL_REPLICA_DIR', 'WALNUT_EPHEMERAL_REMOTE_HOSTS', 'WALNUT_HOST_SERVER_ROOT'] as const
const saved: Record<string, string | undefined> = {}

beforeEach(() => { for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k] } })
afterEach(() => {
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
  vi.restoreAllMocks()
})

const readOnly = (c: DaemonConnection) => (c as unknown as { isReadOnlyRemote: boolean }).isReadOnlyRemote
const dirEnv = (c: DaemonConnection) => (c as unknown as { dirEnv: Record<string, string> }).dirEnv

describe('the decision', () => {
  const env = (over: Record<string, string>): NodeJS.ProcessEnv => ({ WALNUT_EPHEMERAL_REMOTE_HOSTS: '1', WALNUT_EPHEMERAL_REPLICA_HOST: 'devbox', WALNUT_EPHEMERAL_REPLICA_DIR: ISOLATED, WALNUT_HOST_SERVER_ROOT: EPH_ROOT, ...over })

  it('lifts the named alias with an isolated dir, on an ephemeral server only', () => {
    expect(ephemeralReplicaHost('devbox', env({}), true)).toEqual({ lifted: true, asked: true, dir: ISOLATED })
    expect(ephemeralReplicaHost('devbox', env({ WALNUT_EPHEMERAL_REPLICA_DIR: ISOLATED + '/' }), true)).toEqual({ lifted: true, asked: true, dir: ISOLATED })
    // A production server never reads the knob.
    expect(ephemeralReplicaHost('devbox', env({}), false)).toEqual({ lifted: false, asked: false })
  })

  it('never lifts another host, nor the local daemon', () => {
    expect(ephemeralReplicaHost('buildbox', env({}), true)).toEqual({ lifted: false, asked: false })
    expect(ephemeralReplicaHost('__local__', env({ WALNUT_EPHEMERAL_REPLICA_HOST: '__local__' }), true).lifted).toBe(false)
  })

  it('refuses a production dir, in every spelling', () => {
    for (const dir of ['/tmp/open-walnut', '/tmp/open-walnut/', '/tmp/open-walnut/sub', '/tmp//open-walnut', '/home/marina/.cache/open-walnut', '/home/marina/.cache/open-walnut/x', '/home/marina/.open-walnut/tmp', '/private/tmp/open-walnut', '/private/tmp/open-walnut/sub', '/tmp/open-walnut-streams', '/private/tmp/open-walnut-streams/x', '/home/marina/.open-walnut-host/run']) {
      expect(isProdDaemonDir(dir), dir).toBe(true)
      const d = ephemeralReplicaHost('devbox', env({ WALNUT_EPHEMERAL_REPLICA_DIR: dir }), true)
      expect(d, dir).toMatchObject({ lifted: false, asked: true, reason: 'prod-dir' })
    }
    for (const dir of ['/tmp/open-walnut-check', '/tmp/walnut-replica-check/run', '/home/marina/.cache/open-walnut-eph']) expect(isProdDaemonDir(dir), dir).toBe(false)
  })

  it('never lifts the companion\'s box: it comes through its tunnel, where no isolated dir applies', () => {
    expect(ephemeralReplicaHost('__cloudbox__', env({ WALNUT_EPHEMERAL_REPLICA_HOST: '__cloudbox__' }), true)).toMatchObject({ lifted: false, asked: true, reason: 'not-ssh' })
  })

  it('refuses without an isolated host server root, and with the production replica\'s root in any spelling', () => {
    expect(ephemeralReplicaHost('devbox', env({ WALNUT_HOST_SERVER_ROOT: '' }), true)).toMatchObject({ lifted: false, asked: true, reason: 'no-host-root' })
    for (const root of ['$HOME/.open-walnut-host', '$HOME/.open-walnut-host/', '$HOME/.open-walnut-host/sub', '/home/marina/.open-walnut-host', '/home/marina/.open-walnut-host/app']) {
      expect(isProdHostRoot(root), root).toBe(true)
      expect(ephemeralReplicaHost('devbox', env({ WALNUT_HOST_SERVER_ROOT: root }), true), root).toMatchObject({ lifted: false, reason: 'prod-host-root' })
    }
    for (const root of [EPH_ROOT, '/tmp/walnut-replica-check/host', '/home/marina/.open-walnut-host-eph']) expect(isProdHostRoot(root), root).toBe(false)
  })

  it('refuses without the remote-host opt-in, without a dir, and a relative or climbing dir', () => {
    expect(ephemeralReplicaHost('devbox', env({ WALNUT_EPHEMERAL_REMOTE_HOSTS: '' }), true)).toMatchObject({ lifted: false, reason: 'remote-hosts-off' })
    expect(ephemeralReplicaHost('devbox', env({ WALNUT_EPHEMERAL_REPLICA_DIR: '' }), true)).toMatchObject({ lifted: false, reason: 'no-dir' })
    expect(ephemeralReplicaHost('devbox', env({ WALNUT_EPHEMERAL_REPLICA_DIR: 'run' }), true)).toMatchObject({ lifted: false, reason: 'dir-not-absolute' })
    expect(ephemeralReplicaHost('devbox', env({ WALNUT_EPHEMERAL_REPLICA_DIR: '/tmp/x/../open-walnut' }), true)).toMatchObject({ lifted: false, reason: 'dir-not-absolute' })
  })
})

describe('DaemonConnection on an ephemeral server', () => {
  it('the one allowed case: the alias with an isolated dir is not read only, and starts in that dir', () => {
    Object.assign(process.env, { WALNUT_EPHEMERAL_REMOTE_HOSTS: '1', WALNUT_EPHEMERAL_REPLICA_HOST: 'devbox', WALNUT_EPHEMERAL_REPLICA_DIR: ISOLATED, WALNUT_HOST_SERVER_ROOT: EPH_ROOT })
    const warn = vi.spyOn(log.session, 'warn')
    const conn = new DaemonConnection('devbox', TARGET)
    expect(readOnly(conn)).toBe(false)
    expect(dirEnv(conn)).toEqual({ WALNUT_DAEMON_DIR: ISOLATED, WALNUT_STREAMS_DIR: ISOLATED + '/streams' })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('read only lifted'), expect.objectContaining({ host: 'devbox', dir: ISOLATED }))
    // Every other host stays read only.
    expect(readOnly(new DaemonConnection('buildbox', TARGET))).toBe(true)
  })

  it('refusal one: the prod dir keeps the host read only, with the reason logged', () => {
    Object.assign(process.env, { WALNUT_EPHEMERAL_REMOTE_HOSTS: '1', WALNUT_EPHEMERAL_REPLICA_HOST: 'devbox', WALNUT_EPHEMERAL_REPLICA_DIR: '/tmp/open-walnut', WALNUT_HOST_SERVER_ROOT: EPH_ROOT })
    const warn = vi.spyOn(log.session, 'warn')
    const conn = new DaemonConnection('devbox', TARGET)
    expect(readOnly(conn)).toBe(true)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('refused'), expect.objectContaining({ host: 'devbox', reason: 'prod-dir', dir: '/tmp/open-walnut' }))
    expect(dirEnv(conn)).toEqual({})
  })

  it('refusal two: no dir named keeps the host read only, with the reason logged', () => {
    Object.assign(process.env, { WALNUT_EPHEMERAL_REMOTE_HOSTS: '1', WALNUT_EPHEMERAL_REPLICA_HOST: 'devbox' })
    const warn = vi.spyOn(log.session, 'warn')
    expect(readOnly(new DaemonConnection('devbox', TARGET))).toBe(true)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('refused'), expect.objectContaining({ host: 'devbox', reason: 'no-dir' }))
  })
})
