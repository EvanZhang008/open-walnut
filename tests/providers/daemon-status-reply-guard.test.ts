/**
 * A daemon's error reply is no answer, never a death (src/providers/daemon-status-reply.ts).
 *
 * 2026-11-08: the Mac's daemon restarted for a deploy; while it shut down it answered every
 * command with `ok: false` ("Daemon is shutting down; retry after reconnecting"). The session
 * runner's liveness tick read that `status` reply as `alive: false`, wrote the live CLI
 * `stopped`, and the next daemon adopted the CLI mid-turn behind that record. A move later
 * trusted the record and left two live sessions on one task.
 *
 * Pinned: the helper's answers; the readers that turn a reply into a death (the runner's
 * transport check, the health monitor's probe, the reconnect sweep) keep what they knew on an
 * error reply; and every file that sends `status` or `getState` is listed with how it treats an
 * error reply, so a new reader fails here until it says.
 */
import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-status-reply-guard'))

import { statusReplyAlive } from '../../src/providers/daemon-status-reply.js'
import { RemoteSessionManager } from '../../src/providers/remote-session-manager.js'

const REPO = path.resolve(__dirname, '../..')
const SHUTTING_DOWN = { ok: false, error: 'internal daemon error handling status: Daemon is shutting down; retry after reconnecting' }

describe('statusReplyAlive', () => {
  it.each([
    ['an error reply', SHUTTING_DOWN, null],
    ['no reply', null, null],
    ['the daemon does not hold the session', { ok: true, exists: false }, false],
    ['held, process gone', { ok: true, exists: true, alive: false }, false],
    ['held, process running', { ok: true, exists: true, alive: true }, true],
  ])('%s', (_name, reply, want) => {
    expect(statusReplyAlive(reply as never)).toBe(want)
  })
})

describe("the session runner's transport check never reads an error reply as a death", () => {
  function managerAnswering(reply: Record<string, unknown>): RemoteSessionManager {
    const mgr = new RemoteSessionManager('sid-live', '__local__', null)
    const internals = mgr as unknown as { conn: unknown; _sid: string }
    internals.conn = { connected: true, send: async () => reply }
    internals._sid = 'sid-live'
    return mgr
  }
  it('a daemon shutting down: still alive', async () => {
    expect(await managerAnswering(SHUTTING_DOWN).isAlive()).toBe(true)
  })
  it('a daemon that says the process is gone: dead', async () => {
    expect(await managerAnswering({ ok: true, exists: true, alive: false }).isAlive()).toBe(false)
  })
  it('a daemon that says it runs: alive', async () => {
    expect(await managerAnswering({ ok: true, exists: true, alive: true }).isAlive()).toBe(true)
  })
})

// Every file that asks a daemon `status` or `getState`, and how it treats an error reply.
const READERS: Record<string, string> = {
  'src/providers/remote-session-manager.ts': 'isAlive: statusReplyAlive, an error reply reads alive; getState: ok checked, null; the start retry probe: an error reply goes on to the start, which the per-session CLI owner (cli-owner-core.ts) refuses while a CLI of it lives',
  'src/providers/daemon-connection.ts': 'probeDaemonSession and the reconnect sweep: statusReplyAlive, an error reply is null and the record stays; probeDaemonSessionArgs: ok checked, null',
  'src/core/session-reconcile.ts': 'ok checked: null, vetoes nothing',
  'src/core/session-health-monitor.ts': 'ok checked: no snapshot applied',
  'src/core/human-inbox/item-status.ts': "ok checked: 'unavailable'",
  'src/core/sessions/session-lifecycle.ts': "ok checked: 'no_snapshot', nothing written",
  'src/core/sessions/replaced-session.ts': 'ok checked: no answer (null)',
  'src/core/sessions/auto-recover-env.ts': 'ok checked: no evidence (null)',
  'src/core/sessions/direct-host-send.ts': 'the phone\'s direct send: an error reply (ok false) sends nothing and is a transport failure the phone retries, never session_dead',
  'src/web/routes/session-lifecycle-v1.ts': 'exists === true checked: an error reply leaves the projection as it is',
}

describe('every reader of a daemon status is listed', () => {
  it('a new file sending status or getState says how it treats an error reply', () => {
    const found: string[] = []
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (/\.tsx?$/.test(e.name)) {
          // Code only: a comment naming the command reads nothing.
          const code = fs.readFileSync(p, 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
          // Over the daemon link or the companion's bridge alike.
          if (/(\.send|\bbridgeRequest)\(\s*(\w+\s*,\s*)?['"](status|getState)['"]/.test(code)) found.push(path.relative(REPO, p))
        }
      }
    }
    walk(path.join(REPO, 'src'))
    expect(found.sort()).toEqual(Object.keys(READERS).sort())
  })

  it('the readers that turn a reply into a death go through statusReplyAlive', () => {
    const rsm = fs.readFileSync(path.join(REPO, 'src/providers/remote-session-manager.ts'), 'utf8')
    const isAlive = rsm.slice(rsm.indexOf('async isAlive()'), rsm.indexOf('async getState()'))
    expect(isAlive).toContain('statusReplyAlive(result) ?? true')
    const dc = fs.readFileSync(path.join(REPO, 'src/providers/daemon-connection.ts'), 'utf8')
    const probe = dc.slice(dc.indexOf('export async function probeDaemonSession('), dc.indexOf('export async function probeDaemonSessionArgs('))
    expect(probe).toMatch(/statusReplyAlive\(result\)[\s\S]*if \(alive === null\) return null/)
    expect(probe).not.toMatch(/result\.ok && result\.alive/)
    const direct = fs.readFileSync(path.join(REPO, 'src/core/sessions/direct-host-send.ts'), 'utf8')
    expect(direct).toMatch(/if \(status\.ok === false\) \{[\s\S]{0,400}kind: 'transport'/)
    const sweep = dc.slice(dc.indexOf('private async recoverDisconnectedSessions('), dc.indexOf('private async scheduleAutoRecoverIfDead('))
    expect(sweep).toMatch(/if \(statusReplyAlive\(result\) === null\) \{[\s\S]*?continue/)
  })
})
