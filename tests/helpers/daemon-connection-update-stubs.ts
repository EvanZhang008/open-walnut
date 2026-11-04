/**
 * The SSH stub of a DaemonConnection's daemon update, shared by the update tests
 * (daemon-connection-deferred-upgrade, daemon-connection-unmanaged-rollback). Every
 * SSH round trip is answered at sshExec; the deploy is stubbed and seen as `DEPLOY`.
 * No process, socket or tunnel is created.
 */
import { vi } from 'vitest'
import { DaemonConnection, remoteServiceProbePaths } from '../../src/providers/daemon-connection.js'

export const TARGET = { hostname: 'devbox.example.com', user: 'tester' }
export const EXPECTED = 'walnut-daemon-expected00'
export const OLD = 'walnut-daemon-old00000'
export const RUNNING = JSON.stringify({ running: true, pid: 4242, port: 32100 })

export type Priv = Record<string, (...args: unknown[]) => unknown>
export const priv = (c: DaemonConnection) => c as unknown as Priv
export const state = (c: DaemonConnection) => c as unknown as Record<string, unknown>

export function probe(present: string[] = []): string {
  return remoteServiceProbePaths().map((p) => `${present.includes(p) ? 'present' : 'absent'} ${p}`)
    .concat('walnut-service-probe-done').join('\n')
}
export const MANAGED = probe(['$HOME/.config/systemd/user/open-walnut-daemon.service'])

export interface Routes { probe: string; version: string; status?: string; trial?: string; keep?: string }

export function stub(c: DaemonConnection, routes: Routes): string[] {
  const seen: string[] = []
  // What runs the daemon, as a hello says it: with none known no copy can be kept, and nothing is stopped.
  if (state(c)._runtime == null) state(c)._runtime = 'node'
  vi.spyOn(priv(c), 'deployDaemon').mockImplementation(async () => { seen.push('DEPLOY'); return 'node' })
  vi.spyOn(priv(c), 'getExpectedDaemonVersion').mockReturnValue(EXPECTED)
  vi.spyOn(priv(c), 'getLocalBinaryPath').mockResolvedValue('/fixture/daemon')
  vi.spyOn(priv(c), 'sshExec').mockImplementation(async (...args: unknown[]) => {
    const cmd = String(args[0])
    seen.push(cmd)
    // The unmanaged path's trial run and kept previous daemon (daemon-trial-cmd.ts).
    if (cmd.includes('walnut-trial-ok')) return routes.trial ?? 'walnut-trial-ok'
    if (cmd.includes('walnut-previous-kept')) return routes.keep ?? 'walnut-previous-kept'
    if (cmd.includes('walnut-previous-restored')) return 'walnut-previous-restored'
    if (cmd.includes('walnut-service-probe-done')) return routes.probe
    if (cmd.includes('walnut-daemon-stop-confirmed')) return 'walnut-daemon-stop-confirmed\n'
    if (cmd.includes('uname -m')) return 'x86_64'
    if (cmd.includes('--status')) return routes.status ?? RUNNING
    if (cmd.includes('acp-busy.json')) return ''
    if (cmd.includes('daemon.version')) return routes.version
    return ''
  })
  return seen
}

export const destructive = (seen: string[]) => seen.filter((c) => c === 'DEPLOY' || c.includes('--stop') || /\bkill\b(?! -0\b)/.test(c))
