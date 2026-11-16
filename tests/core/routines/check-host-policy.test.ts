/**
 * Where a trigger check may run, by who asks (src/core/routines/check-host-policy.ts).
 *
 * The gate's bypass: a session on a remote exec host ran `trigger_test` with no
 * host, and the check (a curl of this server's /api/health/sleep) ran on this Mac
 * as a local caller. The table pinned here: this Mac and a paired client run a
 * check anywhere, a session on host X only on host X, anything unidentified
 * nowhere. Every entry point asks this table; the e2e file drives them.
 */
import { describe, it, expect, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-check-host-policy'))
// remote-dev and remote-dev-net are two aliases of one daemon process, as its hellos would say.
vi.mock('../../../src/providers/daemon-connection.js', () => ({
  oneDaemon: async (a: string, b: string) => a === b || (new Set([a, b]).size === 2 && [a, b].every((h) => h === 'remote-dev' || h === 'remote-dev-net')),
}))

import {
  assertCheckHostAllowed, checkCallerOrigin, checkCommandChanged, checkHostRefusal,
} from '../../../src/core/routines/check-host-policy.js'
import {
  LOCAL_ORIGIN, REMOTE_HTTP_ORIGIN, UNKNOWN_ORIGIN, hostOrigin, withCallerOrigin,
} from '../../../src/lib/caller-origin.js'
import { SessionControlError } from '../../../src/core/sessions/session-controls.js'

const REMOTE = hostOrigin('remote-dev')

describe('who may run a check where', () => {
  it('a caller on this Mac and a paired client run a check on any host', () => {
    for (const origin of [LOCAL_ORIGIN, REMOTE_HTTP_ORIGIN]) {
      for (const host of ['__local__', '', 'remote-dev', 'other-box']) {
        expect(checkHostRefusal(host, origin), `${origin} on ${host || '(omitted)'}`).toBeNull()
      }
    }
  })

  it('a session on a remote host runs a check on its own host only', () => {
    expect(checkHostRefusal('remote-dev', REMOTE)).toBeNull()
    expect(checkHostRefusal(' remote-dev ', REMOTE)).toBeNull()
    expect(checkHostRefusal('__local__', REMOTE)).toBe(
      'A check that runs on this Mac is accepted only from a caller on this Mac. '
      + 'A session on host remote-dev may run checks on its own host: pass host "remote-dev".')
    // An omitted host is this Mac.
    expect(checkHostRefusal('', REMOTE)).toMatch(/^A check that runs on this Mac/)
    expect(checkHostRefusal('other-box', REMOTE)).toBe(
      'A check that runs on host other-box is accepted only from a caller on this Mac or a session on host other-box. '
      + 'A session on host remote-dev may run checks on its own host: pass host "remote-dev".')
    // A lookalike of its own alias is another host.
    expect(checkHostRefusal('remote-dev2', REMOTE)).not.toBeNull()
    expect(checkHostRefusal('Remote-Dev', REMOTE)).not.toBeNull()
  })

  it('an unidentified caller runs a check nowhere', () => {
    for (const origin of [UNKNOWN_ORIGIN, '', 'garbage', 'host']) {
      for (const host of ['__local__', 'remote-dev']) {
        expect(checkHostRefusal(host, origin), `${origin || '(empty)'} on ${host}`).toMatch(/could not be identified/)
      }
    }
  })

  it('the refusal is a 403, and the origin in effect can only lower who asks', async () => {
    await expect(assertCheckHostAllowed('__local__', REMOTE)).rejects.toThrow(SessionControlError)
    await expect(assertCheckHostAllowed('__local__', REMOTE)).rejects.toMatchObject({ statusCode: 403 })
    await expect(assertCheckHostAllowed('__local__', LOCAL_ORIGIN)).resolves.toBeUndefined()
    // Omitted = the server's own code, unless a lower origin is in effect.
    expect(checkCallerOrigin(undefined)).toBe(LOCAL_ORIGIN)
    expect(checkCallerOrigin('')).toBe(UNKNOWN_ORIGIN)
    await withCallerOrigin(REMOTE, async () => {
      expect(checkCallerOrigin(undefined)).toBe(REMOTE)
      expect(checkCallerOrigin(LOCAL_ORIGIN)).toBe(REMOTE)
      await expect(assertCheckHostAllowed('__local__', undefined)).rejects.toThrow(/runs on this Mac/)
      await expect(assertCheckHostAllowed('remote-dev', LOCAL_ORIGIN)).resolves.toBeUndefined()
    })
  })

  it('a session\'s call over another alias of its host\'s own daemon may arm a check there; another daemon\'s may not', async () => {
    await expect(assertCheckHostAllowed('remote-dev', hostOrigin('remote-dev-net'))).resolves.toBeUndefined()
    await expect(assertCheckHostAllowed('remote-dev-net', REMOTE)).resolves.toBeUndefined()
    await expect(assertCheckHostAllowed('other-box', REMOTE)).rejects.toMatchObject({ statusCode: 403 })
    await expect(assertCheckHostAllowed('__local__', hostOrigin('remote-dev-net'))).rejects.toThrow(/runs on this Mac/)
  })
})

describe('what counts as handing a daemon a new command', () => {
  const saved = { run: 'bash ~/check.sh', cwd: '/srv/app', host: 'remote-dev' }

  it('a create, or a change of run, cwd or host', () => {
    expect(checkCommandChanged(saved, undefined)).toBe(true)
    expect(checkCommandChanged({ ...saved, run: 'curl localhost' }, saved)).toBe(true)
    expect(checkCommandChanged({ ...saved, cwd: '/tmp' }, saved)).toBe(true)
    expect(checkCommandChanged({ ...saved, cwd: undefined }, saved)).toBe(true)
    expect(checkCommandChanged({ ...saved, host: '__local__' }, saved)).toBe(true)
    expect(checkCommandChanged({ ...saved, host: undefined }, saved)).toBe(true)
  })

  it('not the same command again, or a limit change', () => {
    expect(checkCommandChanged({ ...saved }, saved)).toBe(false)
    expect(checkCommandChanged({ ...saved, run: ` ${saved.run} ` }, saved)).toBe(false)
    expect(checkCommandChanged({ ...saved, timeoutSeconds: 90, maxFiresPerDay: 3 } as never, saved)).toBe(false)
    // An omitted host and `__local__` are the same host.
    expect(checkCommandChanged({ run: 'x' }, { run: 'x', host: '__local__' })).toBe(false)
  })
})
