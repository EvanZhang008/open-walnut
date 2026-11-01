/**
 * `walnut net join <companion> <code>`: what an invite link runs on a new machine
 * after Walnut is installed (core/net/net-join-script.ts). It keeps Walnut's daemon
 * running here (`walnut daemon install`), makes this machine's network key (in the
 * daemon, net-core.ts), trades the invite for a place in the user's machines on the
 * cloud companion (routes/net-v1.ts), and hands the daemon its config. The Mac sees
 * the new member and lists it under Settings > Remote Hosts.
 *
 * `walnut net status`: this machine's host network, as its daemon says.
 *
 * Its lines match the script's first step (net-join-script.ts): one column of dots.
 */
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { WebSocket } from '#ws'

const STEP_W = 19
function step(n: number, label: string, text: string): void {
  process.stdout.write(`  ${n}/3  ${(label + ' ').padEnd(STEP_W, '.')} ${text}\n`)
}

/**
 * This account's daemon dir: the one its login service runs (the same choice as
 * `walnut daemon`). WALNUT_JOIN_DAEMON_DIR names another for a test, which then never
 * installs a service.
 */
async function daemonDir(): Promise<string> {
  if (process.env.WALNUT_JOIN_DAEMON_DIR) return process.env.WALNUT_JOIN_DAEMON_DIR
  const { localProductionDaemonDir } = await import('../lib/daemon-dir.js')
  return localProductionDaemonDir()
}

/** One command to this account's own daemon. */
async function daemonRpc(cmd: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<Record<string, unknown>> {
  const port = Number(fs.readFileSync(path.join(await daemonDir(), 'daemon.port'), 'utf8').trim())
  if (!Number.isInteger(port) || port <= 0) throw new Error('the Walnut daemon is not running here')
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { maxPayload: 4 * 1024 * 1024 })
    const timer = setTimeout(() => { try { ws.terminate() } catch { /* gone */ } reject(new Error(`the daemon did not answer ${cmd}`)) }, timeoutMs)
    ws.on('open', () => ws.send(JSON.stringify({ id: 1, cmd, ...params })))
    ws.on('message', (d: Buffer) => {
      let m: Record<string, unknown>
      try { m = JSON.parse(d.toString()) as Record<string, unknown> } catch { return }
      if (m.id !== 1) return
      clearTimeout(timer)
      ws.close()
      resolve(m)
    })
    ws.on('error', (e: Error) => { clearTimeout(timer); reject(e) })
  })
}

async function daemonUp(): Promise<boolean> {
  try { return (await daemonRpc('hello', {}, 5_000)).ok === true } catch { return false }
}

async function waitDaemon(ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await daemonUp()) return true
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

function errText(r: Record<string, unknown>): string {
  const e = r.error as { message?: unknown } | string | undefined
  if (typeof e === 'string') return e
  return typeof e?.message === 'string' ? e.message : 'refused'
}

export async function runNetJoin(origin: string, code: string, opts: { steps?: boolean } = {}): Promise<number> {
  if (!opts.steps) {
    process.stdout.write('Walnut: adding this machine to your Walnut machines\n')
    step(1, 'Walnut', `installed (${process.env.WALNUT_VERSION_LABEL ?? 'this one'})`)
  }
  let base: URL
  try { base = new URL(origin) } catch { step(3, 'Join', `${origin} is not an address`); return 1 }
  if (base.protocol !== 'https:' && process.env.WALNUT_NET_ALLOW_HTTP_JOIN !== '1') { step(3, 'Join', `${origin} is not https; refusing to join over plain HTTP`); return 1 }

  // 2/3: the daemon, as a service that starts at login (or the one already running here).
  if (await daemonUp()) {
    step(2, 'Keep it running', 'on (already running)')
  } else if (process.env.WALNUT_JOIN_DAEMON_DIR) {
    step(2, 'Keep it running', `no daemon answers in ${process.env.WALNUT_JOIN_DAEMON_DIR}`)
    return 1
  } else {
    try {
      const { runDaemonServiceCli } = await import('../providers/daemon-service-cli.js')
      // Its JSON report is for `walnut daemon`; this screen says it in one line.
      const write = process.stdout.write.bind(process.stdout)
      let code = 1
      ;(process.stdout as unknown as { write: (s: string) => boolean }).write = () => true
      try { code = await runDaemonServiceCli('install', { yes: true }) } finally { (process.stdout as unknown as { write: typeof write }).write = write }
      if (code !== 0 || !(await waitDaemon(30_000))) { step(2, 'Keep it running', 'did not start. Run `walnut daemon status` to see why, then this again.'); return 1 }
      step(2, 'Keep it running', 'on (starts when you log in)')
    } catch (err) {
      step(2, 'Keep it running', `${(err as Error).message}`)
      return 1
    }
  }

  // 3/3: this machine's key (made here, it never leaves), then the invite.
  try {
    const hello = await daemonRpc('hello')
    if (!(hello.capabilities as string[] | undefined)?.includes('net-v1')) { step(3, 'Join', 'this Walnut daemon is too old to join. Run `walnut update`, then this again.'); return 1 }
    const ident = await daemonRpc('net.identity')
    if (ident.ok !== true || typeof ident.endpointId !== 'string') { step(3, 'Join', `no network key: ${errText(ident)}`); return 1 }
    const res = await fetch(new URL('/api/v1/net/join', base), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, endpointId: ident.endpointId, hostname: os.hostname(), platform: `${process.platform}-${process.arch}` }),
      signal: AbortSignal.timeout(20_000),
    })
    const body = await res.json().catch(() => ({})) as Record<string, unknown>
    if (!res.ok) { step(3, 'Join', errText(body)); return 1 }
    const conf = await daemonRpc('net.configure', { relays: body.relays, relayRoots: body.relayRoots, members: body.members }, 30_000)
    if (conf.ok !== true) { step(3, 'Join', `joined, but the network did not start here: ${errText(conf)}`); return 1 }
    const name = String(body.name)
    step(3, 'Join', `done: this machine is "${name}"`)
    process.stdout.write(`\nYour Mac lists "${name}" under Settings > Remote Hosts.\n`)
    process.stdout.write(`To take it out later: Settings > Remote Hosts > ${name} > Remove.\n`)
    return 0
  } catch (err) {
    step(3, 'Join', `${(err as Error).message}`)
    return 1
  }
}

export async function runNetStatus(): Promise<number> {
  try {
    const s = await daemonRpc('net.status', {}, 10_000)
    if (s.ok !== true) { process.stderr.write(`walnut net: ${errText(s)}\n`); return 1 }
    process.stdout.write(JSON.stringify({ ...s, id: undefined, ok: undefined }, null, 2) + '\n')
    return 0
  } catch (err) {
    process.stderr.write(`walnut net: ${(err as Error).message}\n`)
    return 1
  }
}
