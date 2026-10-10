/**
 * /api/v1 model menu and picks on a session whose host cannot be asked now
 * (the 2026-10-01 hop fix). The menu answers from the record at once, and when
 * the record says a CLI runs there, `hostNote` says so in the host's own name:
 * its label, else its alias. A stopped session's pick needs no host, and the
 * Mac's own sessions never get a note. A pick for a CLI that cannot be reached
 * is a 503 host_reconnecting in the host's name, and changes nothing.
 *
 * The host-read bound runs for real, as an opaque API: the pool's state goes in,
 * and it either runs the read or throws its HostReconnectingError.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-apiv1-hostnote'))

vi.mock('../../../src/model/model.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/model/model.js')>()),
  sendMessage: vi.fn(async () => { throw new Error('no model calls in this test') }),
}))

// The connection pool as the session controls and the host-read bound see it.
// The bound itself is the real one, used as an opaque API: it reads the pool's
// state and answers, or throws its HostReconnectingError.
const h = vi.hoisted(() => ({
  connected: new Set<string>(),
  wouldWait: 'connected' as 'connected' | 'fails-fast' | 'dialing' | 'cold',
  alive: true,
  label: 'New big devbox',
}))
vi.mock('../../../src/providers/daemon-connection.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/providers/daemon-connection.js')>()),
  isDaemonConnected: (host: string) => h.connected.has(host),
  daemonConnectWouldWait: () => h.wouldWait,
  probeDaemonLiveness: async () => h.alive,
}))

import express from 'express'
import request from 'supertest'
import { sessionControlV1Router } from '../../../src/web/routes/session-control-v1.js'
import { errorHandler } from '../../../src/web/middleware/error-handler.js'
import { WALNUT_HOME, CONFIG_FILE } from '../../../src/constants.js'
import { createSessionRecord, getSessionByClaudeId } from '../../../src/core/session-tracker.js'
import { sessionRunner } from '../../../src/providers/claude-code-session.js'

const LABEL = h.label
const connected = h.connected

function createApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/v1', sessionControlV1Router)
  app.use(errorHandler)
  return app
}

const options = (sid: string) => request(createApp()).get(`/api/v1/sessions/${sid}/model-options`)

async function session(sid: string, host: string | undefined, status: 'idle' | 'stopped') {
  await createSessionRecord(sid, `task-${sid}`, 'proj', '/tmp', {
    ...(host ? { host } : {}), initialProcessStatus: status,
  } as Parameters<typeof createSessionRecord>[4])
}

/** A CLI that answers its reads (the sonnet row, high effort). */
const answeringCli = () => ({
  getSettingsSnapshot: vi.fn(async () => ({ applied: { model: 'sonnet', effort: 'high' } })),
  getModelCatalog: vi.fn(async () => null),
  refreshAppliedSettings: vi.fn(async () => null),
})

let attach: ReturnType<typeof vi.spyOn>

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(path.dirname(CONFIG_FILE), { recursive: true })
  await fs.writeFile(CONFIG_FILE, [
    'version: 1',
    'user:',
    '  name: Tester',
    'hosts:',
    '  devbox:',
    '    hostname: devbox.example.test',
    `    label: ${LABEL}`,
    '  plainbox:',
    '    hostname: plainbox.example.test',
  ].join('\n') + '\n')
  connected.clear()
  h.wouldWait = 'connected'
  h.alive = true
  attach = vi.spyOn(sessionRunner, 'getOrAttachLiveSession').mockResolvedValue(undefined as never)
})

afterEach(async () => {
  attach.mockRestore()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('model-options hostNote, per host class', () => {
  it('a labelled host with no link, CLI recorded as running: the note names the label', async () => {
    await session('note-labelled', 'devbox', 'idle')
    const res = await options('note-labelled')
    expect(res.status, res.text).toBe(200)
    expect(res.body.hostNote).toBe(`Can't reach ${LABEL} right now`)
    expect(res.body.models.length).toBeGreaterThan(0)
    expect(attach, 'no link: the CLI is never asked').not.toHaveBeenCalled()
  })

  it('a host with no label is named by its alias', async () => {
    await session('note-alias', 'plainbox', 'idle')
    const res = await options('note-alias')
    expect(res.status, res.text).toBe(200)
    expect(res.body.hostNote).toBe("Can't reach plainbox right now")
  })

  it('a stopped session on an unreachable host gets no note (its pick needs no host)', async () => {
    await session('note-stopped', 'devbox', 'stopped')
    const res = await options('note-stopped')
    expect(res.status, res.text).toBe(200)
    expect(res.body).not.toHaveProperty('hostNote')
  })

  it('the Mac\'s own session never gets a note', async () => {
    await session('note-local', undefined, 'idle')
    const res = await options('note-local')
    expect(res.status, res.text).toBe(200)
    expect(res.body).not.toHaveProperty('hostNote')
    expect(attach).toHaveBeenCalledTimes(1)
  })

  it('a link that is up but still reconnecting: the bound\'s sentence, in the host\'s name', async () => {
    connected.add('devbox')
    h.wouldWait = 'dialing'
    await session('note-dialing', 'devbox', 'idle')
    const res = await options('note-dialing')
    expect(res.status, res.text).toBe(200)
    expect(res.body.hostNote).toBe(`Reconnecting to ${LABEL}`)
    expect(attach, 'the CLI was never asked').not.toHaveBeenCalled()
  })

  it('a CLI that answered the attach, then its reads went quiet: the note, and the record\'s pick', async () => {
    connected.add('devbox')
    const quiet = { ...answeringCli(), getSettingsSnapshot: vi.fn(() => new Promise<never>(() => {})) }
    attach.mockResolvedValue(quiet as never)
    await session('note-quiet', 'devbox', 'idle')
    // The link answered the attach; a liveness probe now gets no answer.
    h.alive = false
    const res = await options('note-quiet')
    expect(res.status, res.text).toBe(200)
    expect(res.body.hostNote).toBe(`Reconnecting to ${LABEL}`)
    expect(res.body.currentEffort, 'the record\'s pick, not a guess').toBeNull()
    // A quiet-link probe in the read bound answers in seconds; without one the
    // control's own 20s cap does (session-controls.ts cappedControlRead).
  }, 40_000)

  it('a host that answered: no note, the CLI\'s own pick', async () => {
    connected.add('devbox')
    attach.mockResolvedValue(answeringCli() as never)
    await session('note-answered', 'devbox', 'idle')
    const res = await options('note-answered')
    expect(res.status, res.text).toBe(200)
    expect(res.body).not.toHaveProperty('hostNote')
    expect(res.body.currentEffort).toBe('high')
  })

  // The r4d gate's mu08: nothing pinned that the model the CLI reports wins over
  // the one the record holds (the case above checks only the effort).
  it('the model the CLI is running wins over the record\'s; the record answers only when the CLI names none', async () => {
    connected.add('devbox')
    const record = (sid: string) => createSessionRecord(sid, `task-${sid}`, 'proj', '/tmp', {
      host: 'devbox', initialProcessStatus: 'idle', cliModel: 'opus',
    } as Parameters<typeof createSessionRecord>[4])
    attach.mockResolvedValue(answeringCli() as never)
    await record('note-live-model')
    const live = await options('note-live-model')
    expect(live.status, live.text).toBe(200)
    expect(String(live.body.current)).toMatch(/sonnet/i)
    // Control: a CLI that reports no model leaves the record's pick in place.
    attach.mockResolvedValue({ ...answeringCli(), getSettingsSnapshot: vi.fn(async () => ({ applied: { effort: 'high' } })) } as never)
    await record('note-record-model')
    const fallback = await options('note-record-model')
    expect(fallback.status, fallback.text).toBe(200)
    expect(String(fallback.body.current)).toMatch(/opus/i)
  })
})

describe('a pick for a CLI whose host cannot be asked', () => {
  for (const [what, body] of [['model', { model: 'opus' }], ['effort', { effort: 'low' }]] as const) {
    it(`${what}: 503 host_reconnecting in the host's name, and the record is unchanged`, async () => {
      await session(`pick-${what}`, 'devbox', 'idle')
      const before = await getSessionByClaudeId(`pick-${what}`)
      const res = await request(createApp()).post(`/api/v1/sessions/pick-${what}/${what}`).send(body)
      expect(res.status, res.text).toBe(503)
      expect(res.body.error.code).toBe('host_reconnecting')
      expect(res.body.error.message).toBe(`Can't reach ${LABEL} right now`)
      const after = await getSessionByClaudeId(`pick-${what}`)
      expect([after?.model, after?.effort]).toEqual([before?.model, before?.effort])
    })

    it(`${what} on a stopped session: saved for the next start, no host needed`, async () => {
      await session(`pick-stopped-${what}`, 'devbox', 'stopped')
      const res = await request(createApp()).post(`/api/v1/sessions/pick-stopped-${what}/${what}`).send(body)
      expect(res.status, res.text).toBe(200)
      expect(res.body.appliedLive).toBe(false)
    })
  }
})

// The Mac still counts the link as connected, but nothing comes back on it: the
// check for a CLI the record does not know about must not hold a stopped
// session's menu or pick (the cloud-host e2e measured 20s, the full control cap).
describe('a stopped session on a link that is connected but silent', () => {
  beforeEach(() => {
    connected.add('devbox')
    attach.mockImplementation(() => new Promise<never>(() => {}))
  })

  it('the menu answers from the record in seconds, with no note', async () => {
    await session('silent-menu', 'devbox', 'stopped')
    const t0 = Date.now()
    const res = await options('silent-menu')
    expect(res.status, res.text).toBe(200)
    expect(Date.now() - t0).toBeLessThan(8_000)
    expect(res.body).not.toHaveProperty('hostNote')
    expect(attach, 'the host was still asked').toHaveBeenCalledTimes(1)
  }, 30_000)

  it('a pick is saved for the next start in seconds', async () => {
    await session('silent-pick', 'devbox', 'stopped')
    const t0 = Date.now()
    const res = await request(createApp()).post('/api/v1/sessions/silent-pick/model').send({ model: 'opus' })
    expect(res.status, res.text).toBe(200)
    expect(res.body.appliedLive).toBe(false)
    expect(Date.now() - t0).toBeLessThan(8_000)
    expect((await getSessionByClaudeId('silent-pick'))?.cliModel).toBe('opus')
  }, 30_000)

  it('a host that answers still wins over a stale record: its CLI\'s own pick', async () => {
    attach.mockResolvedValue(answeringCli() as never)
    await session('silent-stale', 'devbox', 'stopped')
    const res = await options('silent-stale')
    expect(res.status, res.text).toBe(200)
    expect(res.body.currentEffort).toBe('high')
  })
})
