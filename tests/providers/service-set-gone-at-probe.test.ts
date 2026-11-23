/**
 * Review round 3, S3: a connect never deploys a daemon into this Walnut's service set's runtime dir.
 *
 * The set was uninstalled by hand or the box rebuilt: the link still dials the set's dir (its move is
 * done), the probe finds neither the set's service config nor a daemon there. Before, the connect then
 * deployed an unmanaged daemon with no set env into that dir and pushed this Walnut's triggers, jobs and
 * follower to it, a second daemon of this leader beside the shared one. Now the move is undone at the
 * probe (ServiceSetLink.setGoneAt), before anything is pushed, and the same connect takes today's dir.
 *
 * What's real: DaemonConnection.checkDaemonRunning and deployAndStart's guard. Faked: SSH (sshExec),
 * the dir choice (resolveRemoteDir) and the link's service set part.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DaemonConnection, remoteServiceProbePaths } from '../../src/providers/daemon-connection.js'
import type { SshTarget } from '../../src/providers/session-io.js'

const TARGET: SshTarget = { hostname: 'devbox.example.com', user: 'tester' }
const SET = '0123456789abcdef'
const RT = `/home/tester/.open-walnut-host/walnuts/${SET}/rt`
const TODAY = '/tmp/open-walnut-daemon'

type Priv = Record<string, (...a: unknown[]) => unknown> & { _remoteSet: string; _remoteDir: string }

function setup(o: { liveInSet?: boolean; undoSticks?: boolean; scanFails?: boolean } = {}) {
  const conn = new DaemonConnection('devbox', TARGET)
  const p = conn as unknown as Priv
  p._remoteSet = SET
  p._remoteDir = RT
  const seen: string[] = []
  const gone: string[] = []
  let undone = false
  vi.spyOn(p, 'getExpectedDaemonVersion').mockReturnValue('walnut-daemon-expected00')
  vi.spyOn(p, 'sshExec').mockImplementation(async (...args: unknown[]) => {
    const cmd = String(args[0])
    seen.push(cmd)
    if (cmd.includes('walnut-service-probe-done')) {
      const paths = remoteServiceProbePaths(p._remoteDir, p._remoteSet)
      return [...paths.map((x) => `absent ${x}`), 'walnut-service-probe-done'].join('\n')
    }
    if (cmd.includes('walnut-live')) {
      if (o.scanFails) throw new Error('ssh: connection reset')
      return o.liveInSet && p._remoteDir === RT ? 'walnut-live dir=0 pid=38449 port=39829 runtime=bun' : 'walnut-live none'
    }
    if (cmd.includes('--status')) { if (o.scanFails) throw new Error('ssh: connection reset'); return '' }
    if (cmd.includes('daemon.version')) return 'walnut-daemon-expected00'
    return ''
  })
  // Today's choice once the move is undone; the set's dir while the link still points there.
  vi.spyOn(p, 'resolveRemoteDir').mockImplementation(async () => {
    p._remoteSet = undone && !o.undoSticks ? '' : SET
    p._remoteDir = p._remoteSet ? RT : TODAY
  })
  const link = { setGoneAt: vi.fn(async (dir: string) => { gone.push(dir); undone = true }) }
  vi.spyOn(conn as unknown as { serviceSetLink: unknown }, 'serviceSetLink', 'get').mockReturnValue(link)
  const deploy = vi.spyOn(p, 'loadPendingReplace')
  return { conn, p, seen, gone, deploy }
}

describe('S3: the set\'s runtime dir never gets a deployed daemon', () => {
  afterEach(() => vi.restoreAllMocks())

  it('no service config and no daemon in the set\'s dir: the move is undone at the probe and today\'s dir is looked at instead', async () => {
    const t = setup()
    // Absent at today's dir too: the caller deploys there (trunk behaviour), never in the set's dir.
    await expect(t.p.checkDaemonRunning({ deferUpgrade: true })).resolves.toBeNull()
    expect(t.gone).toEqual([RT])
    expect(t.p._remoteSet).toBe('')
    expect(t.p._remoteDir).toBe(TODAY)
    // The second probe looked at today's dir's service paths, not the set's.
    expect(t.seen.filter((c) => c.includes('walnut-service-probe-done'))).toHaveLength(2)
  })

  it('an undo that did not take (the link still points at the set) refuses the connect: nothing is deployed', async () => {
    const t = setup({ undoSticks: true })
    await expect(t.p.checkDaemonRunning({ deferUpgrade: true })).rejects.toThrow(/deploys nothing there/)
    expect(t.p._remoteDir).toBe(RT)
  })

  it('a daemon that answers in the set\'s dir is served as it is: no undo', async () => {
    const t = setup({ liveInSet: true })
    await expect(t.p.checkDaemonRunning({ deferUpgrade: true })).resolves.toBe(39829)
    expect(t.gone).toEqual([])
  })

  it('a probe that could not reach the host is no "set gone": the connect retries, the move stays', async () => {
    const t = setup({ scanFails: true })
    await expect(t.p.checkDaemonRunning({ deferUpgrade: true })).rejects.toThrow(/connection reset/)
    expect(t.gone).toEqual([])
  })

  it('deployAndStart refuses a set\'s dir before it touches anything', async () => {
    const t = setup()
    await expect(t.p.deployAndStart()).rejects.toThrow(/never deploys a daemon into its service set's dir/)
    expect(t.deploy).not.toHaveBeenCalled()
    expect(t.seen).toEqual([])
  })
})
