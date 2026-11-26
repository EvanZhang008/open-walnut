/**
 * WALNUT_REHEARSAL_HOST_SERVICES={"<host>": {"port": n, "dir": <that machine's folder>, "env": {...}}}: a host's one
 * Walnut service, as the host-server manager runs it there. The rehearsal's transport runs no install
 * (daemon-routes.ts), so the manager cannot start one; this seam sends what it would end with: `server.configure`
 * with the ordinary host replica spec (host-follow.ts oldMachineHostServiceSpec, the spec the switch sends the old
 * machine), from this server's own link to that host's daemon, so the daemon runs it, gives it its follower token, and
 * it follows this Walnut there (a real follower: its leader door, its follower link, its bridge to the companion).
 *
 * Only while this server may act (the leader's socket is the only one a daemon takes `server.configure` from), and only
 * when the host has none running for this home: a switch's new leader finds the one the old leader configured (the
 * host aliases the new path) and leaves it. Nothing in production sets it.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

export interface RehearsalHostService { port: number; dir: string; env?: Record<string, string> }

export async function keepRehearsalHostServices(log: (line: string) => void = (l) => console.log(l)): Promise<void> {
  const raw = process.env.WALNUT_REHEARSAL_HOST_SERVICES
  if (!raw) return
  const services = JSON.parse(raw) as Record<string, RehearsalHostService>
  const [{ currentLeaderPermit }, { link }, { oldMachineHostServiceSpec }, { WALNUT_HOME }, { instanceIdAt }] = await Promise.all([
    import('../../src/core/leader/switch/boot.js'), import('../../src/core/hosts/link.js'), import('../../src/core/leader/switch/host-follow.js'),
    import('../../src/constants.js'), import('../../src/core/device-store.js'),
  ])
  let busy = false
  const look = async (): Promise<void> => {
    const p = currentLeaderPermit()
    if (!p || p.trial || !p.runtime.mayAct()) return
    const walnutId = await instanceIdAt(WALNUT_HOME).catch(() => null)
    if (!walnutId) return
    for (const [host, s] of Object.entries(services)) {
      const conn = await link(host).catch(() => null)
      if (!conn) continue
      const st = await conn.send('server.status', { home: WALNUT_HOME }, 10_000).catch(() => null)
      const state = (st?.status as { state?: string } | undefined)?.state
      if (state && state !== 'off') continue
      const base = path.join(s.dir, 'host-service')
      const dirs = { dataDir: path.join(base, 'data'), runDir: path.join(base, 'run'), logFile: path.join(base, 'logs', 'server.log') }
      for (const d of [dirs.dataDir, dirs.runDir, path.dirname(dirs.logFile)]) fs.mkdirSync(d, { recursive: true, mode: 0o700 })
      const spec = await oldMachineHostServiceSpec({ daemon: conn, home: WALNUT_HOME, walnutId, hostKey: host, port: s.port, dirs, program: { command: process.execPath, prefix: [path.join(REPO, 'src', 'cli.ts')] }, label: host })
      const r = await conn.send('server.configure', { home: WALNUT_HOME, spec: { ...spec, env: { ...(spec.env as Record<string, string>), ...s.env } } }, 15_000).catch((err: unknown) => ({ ok: false, error: err instanceof Error ? err.message : String(err) }))
      log(`REHEARSAL_HOST_SERVICE ${JSON.stringify({ host, port: s.port, ok: r.ok === true, ...(r.ok === true ? {} : { error: String(r.error ?? 'refused') }) })}`)
    }
  }
  setInterval(() => {
    if (busy) return
    busy = true
    void look().catch(() => {}).finally(() => { busy = false })
  }, 3_000).unref()
}
