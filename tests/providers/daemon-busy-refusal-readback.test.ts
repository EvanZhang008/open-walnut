/**
 * Every way a daemon refuses an update because its own work runs (a refusal the `force` of an
 * overdue update goes over) changed nothing on the host. Read back from the detached runner's
 * record after the server's wait ended, it is a hold asked again later, never a failure: on
 * 2026-11-23 four such read backs from a dev host were logged as errors and kept a health alarm
 * on while the old daemon served untouched.
 *
 * The members are enumerated from the source: a new `!force` refusal in the session daemon or the
 * command drain fails here until DAEMON_BUSY_WORDS and the runner's retry cover it.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DAEMON_BUSY_WORDS } from '../../src/providers/daemon-busy-words.js'
import { judgeUpdateRecord, unreadUpdates } from '../../src/providers/daemon-update-readback.js'
import { LaunchedNetUpdate } from '../../src/providers/daemon-net-update-record.js'
import { log } from '../../src/logging/index.js'
import { runnerScript } from '../../src/providers/daemon-net-update-io.js'
import type { NetUpdateRecord } from '../../src/providers/daemon-net-update-io.js'
import type { UpdateTail } from '../../src/providers/daemon-update-tail.js'

const SOURCES = ['daemon-standalone.ts', 'daemon-command-drain.ts']
  .map((f) => path.join(__dirname, '../../src/providers', f))

/** The text of every refusal a `force` goes over, in the daemon and the drain. */
function busyRefusals(): string[] {
  const found = new Set<string>()
  const re = /if \(!(?:opts\.)?force\b[^\n]*\)\s*(?:\{\s*)?(?:return sendError\(ws, id, |throw new Error\()'([^']+)'/g
  for (const file of SOURCES) for (const m of fs.readFileSync(file, 'utf8').matchAll(re)) found.add(m[1])
  return [...found]
}

const serving: UpdateTail = { outcome: 'serving', words: 'a daemon answers' }

function refusedRecord(text: string, tail: UpdateTail | null = serving): NetUpdateRecord {
  const out = JSON.stringify({ ok: false, failure: { code: 'updateRefused', message: `Error: internal daemon error handling service.update: ${text}`, rollback: 'Restored the previous boot script without restarting the running daemon' } }, null, 2)
  return { done: 'rc=1 tries=8 tail=serving\n', out, err: '', tail }
}

describe('a busy refusal read back from the runner record', () => {
  const refusals = busyRefusals()

  it('finds the refusals in the source (the enumeration itself still works)', () => {
    expect(refusals.length).toBeGreaterThanOrEqual(3)
    expect(refusals).toContain('Daemon has active operations; retry after they finish')
  })

  it.each(refusals)('"%s" is a hold: nothing done, no failure, no build hold', (text) => {
    expect(DAEMON_BUSY_WORDS.test(text)).toBe(true)
    expect(judgeUpdateRecord(refusedRecord(text))).toMatchObject({ applied: false, buildFailed: false, nothingDone: true })
  })

  it.each(refusals)('"%s" is retried by the detached runner too', (text) => {
    const script = runnerScript({ directory: '/tmp/walnut-update-x', command: 'true', executable: '/tmp/walnut-update-x/daemon' })
    const words = /grep -Eq '([^']+)' "\$d\/update\.out"/.exec(script)?.[1]
    expect(words).toBeTruthy()
    expect(new RegExp(words!).test(text)).toBe(true)
  })

  it('a busy refusal after which the tail stepped in (put back, stand-in, down) still reads as a failure', () => {
    for (const outcome of ['restored', 'standin', 'down'] as const) {
      expect(judgeUpdateRecord(refusedRecord('Daemon has active operations; retry after they finish', { outcome, words: outcome })).nothingDone).toBe(false)
    }
  })

  it('a refusal that is not a busy one stays a failure', () => {
    expect(judgeUpdateRecord(refusedRecord('service.handover: unsupported platform')).nothingDone).toBe(false)
  })
})

describe('a host network update read back once the host returned', () => {
  afterEach(() => { vi.restoreAllMocks() })
  const dir = '/tmp/open-walnut-update.abc123'

  /** A link whose fs.read answers from these files. */
  function conn(files: Record<string, string>) {
    return { send: async (_cmd: string, params?: Record<string, unknown>) => {
      const text = files[String(params?.path)]
      return text === undefined ? { ok: false, error: 'ENOENT' } : { ok: true, content: text, data: text }
    } }
  }

  async function readBack(out: string, running: string | null) {
    vi.spyOn(unreadUpdates, 'write').mockResolvedValue(undefined as never)
    const error = vi.spyOn(log.session, 'error').mockImplementation(() => {})
    const u = new LaunchedNetUpdate('devbox', () => 1_000)
    u.started(dir, 'walnut-daemon-new', null)
    await u.readBack(conn({ [`${dir}/update.done`]: 'rc=1 tries=8 tail=serving\n', [`${dir}/update.out`]: out }), running, async () => {})
    return { error, unread: u.unread, view: u.view(true, 'walnut-daemon-old') }
  }

  it('a busy refusal on every try logs no error and leaves no failure on the host', async () => {
    const r = await readBack(refusedRecord('Daemon has active operations; retry after they finish').out, 'walnut-daemon-old')
    expect(r.error).not.toHaveBeenCalled()
    expect(r.unread).toBe(false)
    expect(r.view).toBeNull()
  })

  it('a host that already runs the build it was about logs no error, whatever the answer said', async () => {
    const r = await readBack(refusedRecord('service.handover: unsupported platform').out, 'walnut-daemon-new')
    expect(r.error).not.toHaveBeenCalled()
    expect(r.view).toBeNull()
  })

  it('a real refusal on a host still on the old build is still an error', async () => {
    const r = await readBack(refusedRecord('service.handover: unsupported platform').out, 'walnut-daemon-old')
    expect(r.error).toHaveBeenCalledTimes(1)
    expect(r.view?.state).toBe('failed')
  })
})
