/**
 * A relayed read of a host that cannot be reached is the host's condition, not a
 * relay fault.
 *
 * 2026-10-22: the phone (through the cloud companion) opened a session on a host
 * whose SSH proxy login had expired. The primary's `transcript` relay logged
 * "session control relay failed" at error, so a card came up three times. The
 * reader had already written the host's LABEL into the error ("Remote read
 * failed (New big devbox): Connection to New big devbox failed 0s ago"), and a
 * label with spaces named no host, so the card had no `host:` cause and no
 * recovery key, and nothing could ever retire it. The primary's own transcript
 * route answers the same failure with a 503 and no card.
 *
 * Real: session-file-reader's remote read error path, the session tracker, the
 * transcript builder, the control relay, the host display name from config.
 * Mocked: constants (temp dirs), the daemon file reader (the remote host fails
 * the way the pool's failure cache does), and the progress bound (no pool here).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-relay-remote-read'))

const REMOTE = 'devbox'
const LABEL = 'New big devbox'
const remote = vi.hoisted(() => ({ fail: null as Error | null, content: '' }))

vi.mock('../../../src/core/daemon-file-reader.js', async () => {
  const { mockLocalDaemonReader } = await import('../../helpers/mock-local-daemon-reader.js')
  const Local = mockLocalDaemonReader().DaemonFileReader
  class Reader {
    private local: InstanceType<typeof Local> | null
    constructor(private host: string) { this.local = host === REMOTE ? null : new Local(host) }
    private remoteRead(): string | null {
      if (remote.fail) throw remote.fail
      return remote.content || null
    }
    async readFile(p: string, ...rest: unknown[]) {
      if (!this.local) return this.remoteRead()
      return (this.local.readFile as (...a: unknown[]) => Promise<string | null>)(p, ...rest)
    }
    async findSession(sid: string, ...rest: unknown[]) {
      if (!this.local) { const content = this.remoteRead(); return content ? { path: `/remote/${sid}.jsonl`, content } : null }
      return (this.local.findSession as (...a: unknown[]) => Promise<unknown>)(sid, ...rest)
    }
  }
  return { DaemonFileReader: Reader }
})

vi.mock('../../../src/core/hosts/remote-read-bound.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/core/hosts/remote-read-bound.js')>()
  return { ...real, boundByProgress: async <T>(_host: string, work: Promise<T>) => await work }
})

import { WALNUT_HOME, CLAUDE_HOME } from '../../../src/constants.js'
import { createSessionRecord } from '../../../src/core/session-tracker.js'
import { readSessionJsonlContent } from '../../../src/core/session-file-reader.js'
import { RemoteReadError } from '../../../src/core/hosts/remote-read-error.js'
import { handleSessionControlRelay } from '../../../src/core/sessions/session-controls.js'
import { causeKeyForError } from '../../../src/core/notifications/error-cause.js'
import { log } from '../../../src/logging/index.js'

/** The pool's failure-cache wording, alias form (daemon-connection.ts), as the 2026-10-22 card carried it. */
const PROXY_LOGIN_EXPIRED = `Connection to ${REMOTE} failed 0s ago: Error: the SSH proxy refused the connection [walnut-ssh-evidence: proxy-login (the SSH proxy says its own login is invalid or expired)]`
const SLOW_READ = 'Session file read timeout (no data for 30s)'
const SID = '5a1e6c0d-2b7e-4f3a-9c51-7d2e8f0a1b2c'
const CWD = '/home/tester/marina'

const line = (o: unknown) => JSON.stringify(o)
const JSONL = [
  line({ type: 'user', uuid: 'u1', parentUuid: null, timestamp: '2026-10-22T15:00:00.000Z', message: { role: 'user', content: 'Check the build.' } }),
  line({ type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp: '2026-10-22T15:00:05.000Z', message: { id: 'msg_1', role: 'assistant', content: [{ type: 'text', text: 'The build is green.' }] } }),
].join('\n') + '\n'

type Relay = { ok: true; result: { messages: Array<{ text?: string }> } } | { ok: false; error: string; errorKind: string }
const relay = async () => await handleSessionControlRelay('transcript', SID, { rich: true }) as Relay

let warn: ReturnType<typeof vi.spyOn>
let error: ReturnType<typeof vi.spyOn>
const relayErrors = () => error.mock.calls.filter(([m]) => m === 'session control relay failed')
const relayWarns = () => warn.mock.calls.filter(([m]) => m === 'session control relay: the host did not answer a read')

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  await fs.writeFile(path.join(WALNUT_HOME, 'config.yaml'), `hosts:\n  ${REMOTE}:\n    hostname: devbox.example.test\n    label: ${LABEL}\n`)
  await createSessionRecord(SID, '', '', CWD, { title: 'Remote session', host: REMOTE, initialProcessStatus: 'idle' })
})

afterAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
  await fs.rm(CLAUDE_HOME, { recursive: true, force: true }).catch(() => {})
})

beforeEach(() => {
  remote.fail = null
  remote.content = ''
  warn = vi.spyOn(log.session, 'warn')
  error = vi.spyOn(log.session, 'error')
})

afterEach(() => vi.restoreAllMocks())

describe('the reader keeps the host\'s identity in a remote read failure', () => {
  it('a host-link failure: the label in the message, the alias and the raw words on the error, unreachable', async () => {
    remote.fail = new Error(PROXY_LOGIN_EXPIRED)
    const err = await readSessionJsonlContent(SID, CWD, REMOTE).then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(RemoteReadError)
    const e = err as RemoteReadError
    expect(e.message).toBe(`Remote read failed (${LABEL}): Connection to ${LABEL} failed 0s ago: Error: the SSH proxy refused the connection [walnut-ssh-evidence: proxy-login (the SSH proxy says its own login is invalid or expired)]`)
    expect(e.host).toBe(REMOTE)
    expect(e.detail).toBe(PROXY_LOGIN_EXPIRED)
    expect(e.unreachable).toBe(true)
    // The message alone names no host (spaces in the label); the alias does.
    expect(causeKeyForError({ text: e.message })).toBeUndefined()
    expect(causeKeyForError({ text: e.detail, host: e.host })).toBe(`host:${REMOTE}`)
  })

  it('a slow read is not proof the host is down', async () => {
    remote.fail = new Error(SLOW_READ)
    const e = await readSessionJsonlContent(SID, CWD, REMOTE).then(() => null, (x: unknown) => x) as RemoteReadError
    expect(e).toBeInstanceOf(RemoteReadError)
    expect(e.unreachable).toBe(false)
  })
})

describe('the transcript relay for a host that cannot be reached', () => {
  it('answers 503 (unavailable) in the host\'s name, at warn with the alias: no card', async () => {
    remote.fail = new Error(PROXY_LOGIN_EXPIRED)
    const out = await relay()
    expect(out).toMatchObject({ ok: false, errorKind: 'unavailable' })
    expect((out as { error: string }).error).toContain(`Remote read failed (${LABEL})`)
    expect(relayErrors()).toHaveLength(0)
    expect(relayWarns()).toHaveLength(1)
    expect(relayWarns()[0][1]).toMatchObject({ action: 'transcript', host: REMOTE, error: PROXY_LOGIN_EXPIRED })
  })

  it('answers again once the host is back: nothing to retire, the next read is the transcript', async () => {
    remote.fail = new Error(PROXY_LOGIN_EXPIRED)
    expect((await relay()).ok).toBe(false)
    remote.fail = null
    remote.content = JSONL
    const back = await relay()
    expect(back.ok).toBe(true)
    expect((back as { result: { messages: Array<{ text?: string }> } }).result.messages.map((m) => m.text)).toContain('The build is green.')
    expect(relayErrors()).toHaveLength(0)
  })

  it('a failure that is not a host-link failure stays an error card', async () => {
    remote.fail = new Error(SLOW_READ)
    expect(await relay()).toMatchObject({ ok: false, errorKind: 'internal' })
    expect(relayErrors()).toHaveLength(1)
    expect(relayWarns()).toHaveLength(0)
  })
})
