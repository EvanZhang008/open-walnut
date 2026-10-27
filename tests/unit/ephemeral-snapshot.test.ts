/**
 * Snapshot preparation for `web --ephemeral`: the copy must not act as the
 * user's real Walnut.
 *
 *   - pauseSnapshotCronJobs: the copied cron jobs are the user's live
 *     automations (Slack monitor, digests, pipeline watches); a test server that
 *     runs them repeats their real-world effects.
 *   - stripSnapshotPushTokens: the copied config lists the user's real phones;
 *     a test turn finishing with no browser attached pushed to them.
 *   - stopSnapshotTunnels: the copied config runs the user's tunnel; a tunnel
 *     service gives the name to whoever connected last, so the test server took
 *     the user's real address and left it dead when it stopped.
 *   - ephemeralChildEnv: the launcher usually runs inside a session of the real
 *     Walnut, whose env names that Walnut's daemon, socket and API URL.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import yaml from 'js-yaml'
import { dropSnapshotQueuedMessages, ephemeralChildEnv, pauseSnapshotCronJobs, stopSnapshotTriage, stopSnapshotTunnels, stripSnapshotPushTokens } from '../../src/commands/ephemeral-snapshot.js'

let dir: string
const cronFile = () => path.join(dir, 'cron-jobs.json')

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-snapshot-test-')) })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

describe('pauseSnapshotCronJobs', () => {
  it('disables every enabled job, keeps the rest of each job, and counts them', () => {
    fs.writeFileSync(cronFile(), JSON.stringify({
      version: 1,
      jobs: [
        { id: 'a', name: 'Slack monitor', enabled: true, schedule: { kind: 'every', everyMs: 60000 } },
        { id: 'b', name: 'Already off', enabled: false },
        { id: 'c', name: 'Digest', enabled: true, payload: { message: 'hi' } },
      ],
    }))
    expect(pauseSnapshotCronJobs(dir)).toBe(2)
    const store = JSON.parse(fs.readFileSync(cronFile(), 'utf-8'))
    expect(store.version).toBe(1)
    expect(store.jobs.map((j: { enabled: boolean }) => j.enabled)).toEqual([false, false, false])
    expect(store.jobs[0].schedule).toEqual({ kind: 'every', everyMs: 60000 })
    expect(store.jobs[2].payload).toEqual({ message: 'hi' })
  })

  it('a job without an enabled field counts as enabled (the engine treats it so)', () => {
    fs.writeFileSync(cronFile(), JSON.stringify({ version: 1, jobs: [{ id: 'x', name: 'n' }] }))
    expect(pauseSnapshotCronJobs(dir)).toBe(1)
    expect(JSON.parse(fs.readFileSync(cronFile(), 'utf-8')).jobs[0].enabled).toBe(false)
  })

  it('leaves the file byte-identical when nothing is enabled', () => {
    const raw = JSON.stringify({ version: 1, jobs: [{ id: 'b', enabled: false }] })
    fs.writeFileSync(cronFile(), raw)
    expect(pauseSnapshotCronJobs(dir)).toBe(0)
    expect(fs.readFileSync(cronFile(), 'utf-8')).toBe(raw)
  })

  it('never throws on a missing, corrupt or odd-shaped store', () => {
    expect(pauseSnapshotCronJobs(dir)).toBe(0)
    fs.writeFileSync(cronFile(), '{ not json')
    expect(pauseSnapshotCronJobs(dir)).toBe(0)
    expect(fs.readFileSync(cronFile(), 'utf-8')).toBe('{ not json')
    fs.writeFileSync(cronFile(), JSON.stringify({ jobs: 'nope' }))
    expect(pauseSnapshotCronJobs(dir)).toBe(0)
  })
})

describe('dropSnapshotQueuedMessages', () => {
  const queueFile = () => path.join(dir, 'session-message-queue.json')
  const row = (id: string, sessionId: string, status: string) =>
    ({ id, sessionId, message: 'hi', status, enqueuedAt: '2026-10-24T07:00:00.000Z' })

  it('empties every queue (pending, processing and parked) and keeps the bookkeeping', () => {
    fs.writeFileSync(queueFile(), JSON.stringify({
      version: 1,
      queues: {
        'sid-a': [row('qm-1', 'sid-a', 'pending'), row('qm-2', 'sid-a', 'processing')],
        'sid-b': [row('qm-3', 'sid-b', 'parked')],
        'sid-c': [],
      },
      settled: { 'qm-0': 'uuid-0' },
      relay: { 'qm-mobile-1': ['taken', 1] },
    }))
    expect(dropSnapshotQueuedMessages(dir)).toBe(3)
    const store = JSON.parse(fs.readFileSync(queueFile(), 'utf-8'))
    expect(store).toEqual({ version: 1, queues: {}, settled: { 'qm-0': 'uuid-0' }, relay: { 'qm-mobile-1': ['taken', 1] } })
  })

  it('a missing store, or one with nothing queued, is left alone and is no failure', () => {
    expect(dropSnapshotQueuedMessages(dir)).toBe(0)
    expect(fs.existsSync(queueFile())).toBe(false)
    const raw = JSON.stringify({ version: 1, queues: { 'sid-a': [] } })
    fs.writeFileSync(queueFile(), raw)
    expect(dropSnapshotQueuedMessages(dir)).toBe(0)
    expect(fs.readFileSync(queueFile(), 'utf-8')).toBe(raw)
    fs.writeFileSync(queueFile(), JSON.stringify({ version: 1 }))
    expect(dropSnapshotQueuedMessages(dir)).toBe(0)
  })

  it('removes a store it cannot parse or understand (fail closed), never leaving rows behind', () => {
    for (const raw of ['{ not json', '[]', 'null', JSON.stringify({ version: 1, queues: [row('qm-1', 's', 'pending')] })]) {
      fs.writeFileSync(queueFile(), raw)
      expect(dropSnapshotQueuedMessages(dir)).toBe(0)
      expect(fs.existsSync(queueFile())).toBe(false)
    }
  })

  it('counts a malformed queue entry and still empties it', () => {
    fs.writeFileSync(queueFile(), JSON.stringify({ version: 1, queues: { 'sid-a': { id: 'qm-1' } } }))
    expect(dropSnapshotQueuedMessages(dir)).toBe(1)
    expect(JSON.parse(fs.readFileSync(queueFile(), 'utf-8')).queues).toEqual({})
  })

  it('removes the store when it cannot be rewritten', () => {
    fs.writeFileSync(queueFile(), JSON.stringify({ version: 1, queues: { 'sid-a': [row('qm-1', 'sid-a', 'pending')] } }))
    // A directory where the temp file goes makes the write fail.
    fs.mkdirSync(`${queueFile()}.${process.pid}.tmp`)
    expect(dropSnapshotQueuedMessages(dir)).toBe(1)
    expect(fs.existsSync(queueFile())).toBe(false)
  })
})

describe('stripSnapshotPushTokens', () => {
  const cfg = (name = 'config.yaml') => path.join(dir, name)
  const tokens = (n: number) => Array.from({ length: n }, (_, i) => ({ token: `a1b2c3d4e5f6${i}`, platform: 'ios' }))

  it('removes the tokens from config.yaml and its .bak, keeping every other setting', () => {
    fs.writeFileSync(cfg(), yaml.dump({ version: 1, user: { name: 'u' }, hosts: { box: { ssh: 'box' } }, push_tokens: tokens(2) }))
    fs.writeFileSync(cfg('config.yaml.bak'), yaml.dump({ version: 1, push_tokens: tokens(1) }))
    expect(stripSnapshotPushTokens(dir)).toBe(3)
    const main = yaml.load(fs.readFileSync(cfg(), 'utf-8')) as Record<string, unknown>
    expect(main).toEqual({ version: 1, user: { name: 'u' }, hosts: { box: { ssh: 'box' } } })
    expect(yaml.load(fs.readFileSync(cfg('config.yaml.bak'), 'utf-8'))).toEqual({ version: 1 })
  })

  it('leaves a config without tokens byte-identical', () => {
    const raw = '# my comment\nversion: 1\nuser:\n  name: u\n'
    fs.writeFileSync(cfg(), raw)
    expect(stripSnapshotPushTokens(dir)).toBe(0)
    expect(fs.readFileSync(cfg(), 'utf-8')).toBe(raw)
  })

  it('fails closed: a file that names push_tokens but cannot be parsed is removed', () => {
    fs.writeFileSync(cfg(), 'push_tokens: [ {token: abc\n  : : :')
    stripSnapshotPushTokens(dir)
    expect(fs.existsSync(cfg())).toBe(false)
  })

  it('never throws when there is no config at all', () => {
    expect(stripSnapshotPushTokens(dir)).toBe(0)
  })
})

describe('stopSnapshotTriage', () => {
  const cfg = (name = 'config.yaml') => path.join(dir, name)

  it('turns triage off in both config copies, keeping its other settings and the rest', () => {
    const doc = { version: 1, triage: { enabled: true, every: '1h', active_hours: '08-20' }, expose: { enabled: false } }
    fs.writeFileSync(cfg(), yaml.dump(doc))
    fs.writeFileSync(cfg('config.yaml.bak'), yaml.dump(doc))
    expect(stopSnapshotTriage(dir)).toBe(1)
    for (const name of ['config.yaml', 'config.yaml.bak']) {
      const back = yaml.load(fs.readFileSync(cfg(name), 'utf-8')) as typeof doc
      expect(back.triage).toEqual({ enabled: false, every: '1h', active_hours: '08-20' })
      expect(back.version).toBe(1)
      expect(back.expose).toEqual({ enabled: false })
    }
  })

  it('leaves a config without triage on byte for byte', () => {
    const raw = 'version: 1\ntriage:\n  enabled: false\n'
    fs.writeFileSync(cfg(), raw)
    expect(stopSnapshotTriage(dir)).toBe(0)
    expect(fs.readFileSync(cfg(), 'utf-8')).toBe(raw)
    expect(stopSnapshotTriage(fs.mkdtempSync(path.join(dir, 'empty-')))).toBe(0)
  })

  it('removes a copy it cannot parse that mentions triage (fail closed)', () => {
    fs.writeFileSync(cfg(), 'triage: [unclosed\n')
    expect(stopSnapshotTriage(dir)).toBe(0)
    expect(fs.existsSync(cfg())).toBe(false)
  })
})

describe('stopSnapshotTunnels', () => {
  const cfg = (name = 'config.yaml') => path.join(dir, name)

  it('turns off this computer\'s tunnel and every host server\'s, keeping every other setting', () => {
    const doc = {
      version: 1,
      expose: { enabled: true, provider: 'acme-tunnel', options: { name: 'walnut' }, run_on: 'box' },
      hosts: {
        box: { hostname: 'box.example.test', server: { enabled: true, expose: { enabled: true, provider: 'acme-tunnel', options: { name: 'box' } } } },
        idle: { hostname: 'idle.example.test', server: { enabled: true, expose: { enabled: false } } },
        bare: { hostname: 'bare.example.test' },
      },
    }
    fs.writeFileSync(cfg(), yaml.dump(doc))
    fs.writeFileSync(cfg('config.yaml.bak'), yaml.dump(doc))
    expect(stopSnapshotTunnels(dir)).toBe(2)
    for (const name of ['config.yaml', 'config.yaml.bak']) {
      const out = yaml.load(fs.readFileSync(cfg(name), 'utf-8')) as typeof doc
      expect(out.expose).toEqual({ ...doc.expose, enabled: false })
      expect(out.hosts.box.server).toEqual({ enabled: true, expose: { ...doc.hosts.box.server.expose, enabled: false } })
      expect(out.hosts.idle).toEqual(doc.hosts.idle)
      expect(out.hosts.bare).toEqual(doc.hosts.bare)
    }
  })

  it('leaves a config with no tunnel on byte-identical', () => {
    const raw = '# my comment\nversion: 1\nexpose:\n  enabled: false\n'
    fs.writeFileSync(cfg(), raw)
    expect(stopSnapshotTunnels(dir)).toBe(0)
    expect(fs.readFileSync(cfg(), 'utf-8')).toBe(raw)
  })

  it('fails closed: a file that names expose but cannot be parsed is removed; no config never throws', () => {
    expect(stopSnapshotTunnels(dir)).toBe(0)
    fs.writeFileSync(cfg(), 'expose: { enabled: true\n  : : :')
    stopSnapshotTunnels(dir)
    expect(fs.existsSync(cfg())).toBe(false)
  })
})

describe('ephemeralChildEnv', () => {
  it('points the child at its snapshot and runtime dir and drops every link back to the parent Walnut', () => {
    const parent: NodeJS.ProcessEnv = {
      PATH: '/usr/bin',
      HOME: '/home/u',
      OPEN_WALNUT_HOME: '/home/u/.open-walnut',
      WALNUT_DAEMON_DIR: '/tmp/open-walnut',
      WALNUT_STREAMS_DIR: '/home/u/.open-walnut/tmp/streams',
      WALNUT_LEGACY_STREAMS_DIR: '/tmp/open-walnut-streams',
      WALNUT_FORCE_STREAMS_MIGRATION: '1',
      WALNUT_DAEMON_PARENT_PID: '123',
      WALNUT_AGENT_SOCKET: '/tmp/open-walnut/agent-gateway.sock',
      WALNUT_SESSION_ID: 'e2001501-c999-4d32-8b69-58a6c4f03241',
      OPEN_WALNUT_API_URL: 'http://127.0.0.1:3456',
      WALNUT_SERVER_URL: 'http://localhost:3456',
    }
    const env = ephemeralChildEnv(parent, '/var/t/open-walnut-9-abcdef', '/tmp/open-walnut-eph-9-abcdef')
    expect(env.OPEN_WALNUT_HOME).toBe('/var/t/open-walnut-9-abcdef')
    expect(env.WALNUT_DAEMON_DIR).toBe('/tmp/open-walnut-eph-9-abcdef')
    expect(env.PATH).toBe('/usr/bin')
    expect(env.HOME).toBe('/home/u')
    for (const key of [
      'WALNUT_STREAMS_DIR', 'WALNUT_LEGACY_STREAMS_DIR', 'WALNUT_FORCE_STREAMS_MIGRATION',
      'WALNUT_DAEMON_PARENT_PID', 'WALNUT_AGENT_SOCKET', 'WALNUT_SESSION_ID',
      'OPEN_WALNUT_API_URL', 'WALNUT_SERVER_URL',
    ]) expect(env[key], key).toBeUndefined()
    // The parent's env object is not mutated.
    expect(parent.WALNUT_DAEMON_DIR).toBe('/tmp/open-walnut')
  })
})
