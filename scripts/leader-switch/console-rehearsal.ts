/**
 * The old leader's console after a switch (docs/reference/leader-switch.md, "The old leader's
 * console"), with real servers: A leads, the switch moves the lead to B, A's machine becomes a
 * host of B (its own host daemon runs B's replica there), and that replica serves A's console at
 * A's address. Checked as the Mac app sees it (mac-app-replay.ts, run the whole time), as a
 * person's browser sees it (console-browser.ts), with B cut off, and against A's home by its
 * manifest classes (console-world.ts). Only the Claude CLI is a stand-in.
 *
 *   bun scripts/leader-switch-rehearsal.ts --console [--as-installed] [--away-seconds 300]
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { Checks, consoleLeft, seed, waitForBatch, type Check } from './rehearsal.js'
import { makeConsoleWorld, HOST_KEY_A, type ConsoleWorld } from './console-world.js'
import { compareKept, describeKept, snapshotHome } from '../../src/core/home-manifest/home-kept.js'
import { MacAppReplay } from './mac-app-replay.js'
import { REPO, type Machine } from './world.js'
import { readSwitchOutcome as readSwitchState } from '../../src/core/leader/switch/flow.js'
import { readConsoleFile, readHolder } from '../../src/core/handed-over-console.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function until<T>(what: string, fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, timeoutMs: number, everyMs = 500): Promise<T | null> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const v = await Promise.resolve(fn()).catch(() => null)
    if (v) return v as T
    if (Date.now() > deadline) return null
    await sleep(everyMs)
  }
}

/** `walnut web --port <p>` on a home, exactly as the Mac app starts it (desktop/main.swift). */
export function appCommand(m: Machine, port: number): { cmd: string; args: string[]; env: Record<string, string> } {
  return {
    cmd: process.execPath,
    args: [path.join(REPO, 'src/cli.ts'), 'web', '--port', String(port)],
    env: {
      ...process.env as Record<string, string>, ...m.env, OPEN_WALNUT_HOME: m.home,
      OPEN_WALNUT_EXIT_ON_ORPHAN: '1', WALNUT_LAUNCHER: 'mac-app', WALNUT_NO_AUTO_UPDATE: '1', WALNUT_DISABLE_SEARCH: '1',
    },
  }
}

/**
 * One `walnut web --port <p>` by hand on the handed-over home while this machine's replica serves
 * the console there: it should say so and stay, holding nothing (handed-over.ts). Waits for its
 * line (or its exit), checks the port still answers as this Walnut's console, then stops it
 * (SIGTERM) and reports how it ended.
 */
export async function byHandBesideConsole(m: Machine, port: number, walnutId: string, timeoutMs = 120_000): Promise<{ ok: boolean; detail: string }> {
  const { cmd, args, env } = appCommand(m, port)
  const child = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  child.stdout.on('data', (d) => { out += String(d) })
  child.stderr.on('data', (d) => { out += String(d) })
  let exited: number | null | undefined
  const gone = new Promise<void>((resolve) => child.on('exit', (code) => { exited = code; resolve() }))
  const said = await until('the console line', () => (/listening on http:\/\/localhost:\d+: served by this machine's replica of/.test(out) || exited !== undefined ? true : null), timeoutMs, 250)
  const inst = await fetch(`http://127.0.0.1:${port}/api/v1/instance`).then((r) => r.json() as Promise<{ instance?: string }>).catch(() => null)
  const stayed = exited === undefined
  try { child.kill('SIGTERM') } catch { /* gone */ }
  await Promise.race([gone, sleep(20_000)])
  const last = out.trim().split('\n').filter((l) => /listening on|standby|console/.test(l)).slice(-1)[0] ?? out.trim().split('\n').slice(-1)[0]
  return {
    ok: !!said && stayed && inst?.instance === walnutId && exited === 0,
    detail: `${stayed ? 'stayed' : `exited ${exited} by itself`}; the port answers as ${inst?.instance === walnutId ? 'this Walnut' : JSON.stringify(inst)}; ended ${exited === undefined ? 'not' : `code ${exited}`} after SIGTERM | ${last}`,
  }
}

export interface ConsoleRehearsalOptions {
  portA?: number
  portB?: number
  asInstalled?: boolean
  /** How long B is cut off (SIGSTOP) with the console open. */
  awaySeconds?: number
  /** Runs while the console serves and B leads (the browser walk); its checks go into the same list. */
  online?: (cw: ConsoleWorld, c: Checks) => Promise<void>
  /** Runs while B is cut off. */
  away?: (cw: ConsoleWorld, c: Checks) => Promise<void>
  /** Runs once B is back, before the switch back. */
  back?: (cw: ConsoleWorld, c: Checks) => Promise<void>
  /** Before A boots: write a large home (console-scale.ts). */
  seedHome?: (home: string, env: Record<string, string>) => Promise<void>
  log?: (s: string) => void
}

export async function rehearseConsole(root: string, print: (c: Check) => void, opts: ConsoleRehearsalOptions = {}): Promise<Checks> {
  const log = opts.log ?? (() => {})
  const c = new Checks(print)
  const cw = await makeConsoleWorld(root, { portA: opts.portA ?? 4741, portB: opts.portB ?? 4742, asInstalled: opts.asInstalled ?? false })
  const a = cw.side(cw.a)
  const appLog: string[] = []
  const replay = new MacAppReplay({ home: cw.a.home, ports: [cw.a.port], command: (p) => appCommand(cw.a, p), log: (e) => appLog.push(JSON.stringify(e)) })
  let stoppedB: number | null = null
  try {
    if (opts.seedHome) await opts.seedHome(cw.a.home, { ...cw.a.env, OPEN_WALNUT_HOME: cw.a.home })
    log('A seeded')
    const started = await a.startServer('leader', 300_000)
    if (!c.add('A starts as the leader', started.ok, `${started.why ?? ''}${!started.ok && started.logTail ? ` | log: ${started.logTail.slice(-1500)}` : ''}`)) return c
    const s = await seed(cw, cw.a, 5)
    const t0 = Date.now()
    await waitForBatch(cw.b.standbyDir, t0, 600_000)
    await waitForBatch(cw.b.standbyDir, Date.now(), 600_000)
    const sw = await cw.cli(cw.a.home, ['leader', 'switch', '--to', cw.b.id])
    log(sw.out)
    const st = readSwitchState(cw.a.home)
    if (!c.add('switch A -> B completes', sw.code === 0 && st?.step === 'done', `exit ${sw.code}; ${sw.out.trim().split('\n').slice(-4).join(' | ')}`)) return c
    // The console minted at the handover: its file on A's machine, its device on B.
    const files = fs.existsSync(cw.consoleDir) ? fs.readdirSync(cw.consoleDir).filter((f) => f.endsWith('.json') && !f.endsWith('.holder.json')) : []
    const walnutId = files.length === 1 ? files[0]!.replace(/\.json$/, '') : ''
    const con = walnutId ? readConsoleFile(walnutId, cw.consoleDir) : null
    const devices = await cw.api(cw.b, 'GET', '/api/devices').catch(() => null)
    const names = ((devices?.json?.devices ?? []) as Array<{ name?: string }>).map((d) => d.name)
    c.add('the handover wrote this machine\'s console file (outside the home) and its device rode the data to B',
      !!con && con.port === cw.a.port && con.switchId === st?.id && names.includes(con.device) && !fs.readFileSync(path.join(cw.b.home, 'auth.json'), 'utf8').includes(con.token),
      JSON.stringify({ files, port: con?.port, device: con?.device, onB: names.filter((n) => n?.startsWith('console-')), walnutId }))
    const homeAfterSwitch = await snapshotHome(cw.a.home)
    // The switch itself started A's home as the standby at the stop when A's server ran the daemon in its own
    // process (source-job.ts: the standby holds it again): the app then finds it and attaches, spawning nothing.
    const switchStandby = /its home runs as the standby/.test(sw.out)
    const appSpawns = switchStandby ? 0 : 1
    // Phase 1: the Mac app, with only the standby page (the replica is not up yet).
    replay.start()
    const loaded = await until('the app shows the standby', () => replay.attachedPort() === cw.a.port, 120_000)
    const page1 = await fetch(`http://127.0.0.1:${cw.a.port}/`).then(async (r) => ({ status: r.status, text: await r.text() })).catch(() => null)
    c.add(`phase 1 (standby only): the app ${switchStandby ? 'attaches to the standby the switch started' : 'starts `walnut web`, a standby,'} and shows its page`, !!loaded && page1?.status === 200 && /<title>Walnut: standby<\/title>/.test(page1.text) && replay.spawns().length === appSpawns,
      `${replay.spawns().length} spawn(s); / ${page1?.status}`)
    await sleep(15_000)
    // Phase 2: A becomes a host of B, and B's replica there takes the console.
    const hostConfig = await cw.api(cw.b, 'PUT', '/api/config', { hosts: { [HOST_KEY_A]: { hostname: `${HOST_KEY_A}.invalid`, label: HOST_KEY_A, server_program: 'replica' } } })
    const enable = await cw.api(cw.b, 'PUT', `/api/host-servers/${HOST_KEY_A}`, { enabled: true })
    c.add('B takes A as a host and runs a replica there', hostConfig.status < 300 && enable.status < 300, `config ${hostConfig.status}, server ${enable.status} ${JSON.stringify(enable.json)?.slice(0, 200)}`)
    const serving = await until('the console replica serves', () => {
      const h = readHolder(walnutId, cw.consoleDir)
      return h?.state === 'serving' ? h : null
    }, 300_000)
    await sleep(3_000)
    const exits = replay.events.filter((e) => e.kind === 'server_exited')
    const inst = await fetch(`http://127.0.0.1:${cw.a.port}/api/v1/instance`).then((r) => r.json() as Promise<{ instance?: string }>).catch(() => null)
    c.add('phase 2: the standby gives its port to the replica, which serves the console there, and stays (the app\'s process never ends)',
      !!serving && serving.port === cw.a.port && exits.length === 0 && inst?.instance === walnutId,
      `${JSON.stringify(serving)}; the port answers as ${inst?.instance === walnutId ? 'this Walnut' : JSON.stringify(inst)}; app child exits ${exits.length}`)
    const restarts = () => replay.events.filter((e) => e.kind === 'restart_scheduled').length
    c.add('phase 3: the app stays on its port, now the replica\'s console (no restart, no spawn)', replay.attachedPort() === cw.a.port && restarts() === 0 && replay.spawns().length === appSpawns,
      `spawns ${replay.spawns().length} (expected ${appSpawns}), restarts ${restarts()}`)
    // The console answers as B: its data, its writes land on B once.
    const tasks = await cw.api(cw.a, 'GET', '/api/tasks')
    const seen = ((tasks.json?.tasks ?? []) as Array<{ id: string }>).map((t) => t.id)
    c.add('the console at A\'s address reads B\'s tasks', tasks.status === 200 && s.tasks.every((t) => seen.includes(t.id)), `${tasks.status}, ${seen.length} tasks`)
    const title = `written at A's console ${randomBytes(3).toString('hex')}`
    const made = await cw.api(cw.a, 'POST', '/api/tasks', { title, project: 'Rehearsal' })
    const onB = await cw.api(cw.b, 'GET', '/api/tasks?project=Rehearsal')
    const copies = ((onB.json?.tasks ?? []) as Array<{ title: string }>).filter((t) => t.title === title).length
    c.add('a write at the console lands on B, once', made.status < 300 && copies === 1, `${made.status}; on B ${copies}`)
    const cfg = await cw.api(cw.a, 'GET', '/api/config')
    c.add('GET /api/config at the console reports a login session the Mac app never acts on', cfg.status === 200 && cfg.json?.loginSession?.ok === true && Array.isArray(cfg.json?.loginSession?.problems) && cfg.json.loginSession.problems.length === 0, JSON.stringify(cfg.json?.loginSession))
    if (opts.online) await opts.online(cw, c)
    // A start by hand of `walnut web` on the handed-over home: never a leader, it says where the console is.
    const byHand = await byHandBesideConsole(cw.a, cw.a.port, walnutId)
    c.add('`walnut web --port <p>` on the handed-over home says the replica serves the console there and stays without the port (witnesses online)', byHand.ok, byHand.detail)
    for (const x of cw.witnesses) fs.renameSync(x.dir, `${x.dir}.off`)
    try {
      const off = await byHandBesideConsole(cw.a, cw.a.port, walnutId)
      c.add('... the same with every witness out of reach', off.ok, off.detail)
    } finally {
      for (const x of cw.witnesses) fs.renameSync(`${x.dir}.off`, x.dir)
    }
    // Phase 4: B cut off with the console open.
    const pidB = cw.leaderPid()
    if (pidB) {
      process.kill(pidB, 'SIGSTOP')
      stoppedB = pidB
      const awayStarted = Date.now()
      log(`B (pid ${pidB}) stopped`)
      const awayRead = await until('the console reads from its copies', async () => {
        const r = await cw.api(cw.a, 'GET', '/api/tasks')
        return r.status === 200 && r.headers.get('x-walnut-offline') ? r : null
      }, 120_000, 1_000)
      c.add('B cut off: the console answers reads from this machine\'s copies, and says so', !!awayRead, awayRead ? `x-walnut-offline ${awayRead.headers.get('x-walnut-offline')}` : 'no away answer in 120 s')
      if (opts.away) await opts.away(cw, c)
      const rest = (opts.awaySeconds ?? 60) * 1000 - (Date.now() - awayStarted)
      if (rest > 0) await sleep(rest)
      process.kill(pidB, 'SIGCONT')
      stoppedB = null
      log(`B continued after ${((Date.now() - awayStarted) / 1000).toFixed(0)} s`)
      const back = await until('the console forwards to B again', async () => {
        const r = await cw.api(cw.a, 'GET', '/api/tasks')
        return r.status === 200 && !r.headers.get('x-walnut-offline') ? r : null
      }, 180_000, 1_000)
      c.add('B back: the console forwards to B again', !!back)
      if (opts.back) await opts.back(cw, c)
    } else {
      c.add('B cut off', false, 'no pid for B')
    }
    // The Mac app, the whole time: no stop of a server, no spawn loop, no error screen, shown now.
    const kills = replay.kills()
    c.add('the Mac app never stopped a server, never restarted or looped, and shows the console', kills.length === 0 && replay.errors().length === 0 && replay.spawns().length === appSpawns && restarts() === 0 && replay.attachedPort() === cw.a.port,
      `kills ${JSON.stringify(kills)}; spawns ${replay.spawns().length} (expected ${appSpawns}); restarts ${restarts()}; errors ${JSON.stringify(replay.errors())}; shown ${replay.attachedPort()}`)
    // A's home, by the manifest's classes: what is leader data or this machine's is byte for byte as handed over.
    const kept = compareKept(homeAfterSwitch, await snapshotHome(cw.a.home))
    c.add(`A's handed-over home: no path of the leader's data or this machine's data changed (by the manifest's classes)${cw.asInstalled ? ', its daemon keeping its state inside it, as installed' : ''}`,
      kept.ok, describeKept(kept))
    await replay.stop()
    // Switch back: A leads again at its address, the console door closes first.
    await waitForBatch(cw.a.standbyDir, Date.now(), 600_000)
    const back = await cw.cli(cw.b.home, ['leader', 'switch', '--back'])
    log(back.out)
    const sb = readSwitchState(cw.b.home)
    c.add('switch back B -> A completes, A leads at its own port again', back.code === 0 && sb?.step === 'done' && (await cw.api(cw.a, 'GET', '/api/leader/status')).json?.permit?.mayAct === true,
      `exit ${back.code}; ${back.out.trim().split('\n').slice(-3).join(' | ')}`)
    c.add('the console door closed (no holder), the replica no longer listens at A\'s address', !readHolder(walnutId, cw.consoleDir), JSON.stringify(readHolder(walnutId, cw.consoleDir)))
    const left = consoleLeft(cw.a)
    c.add('A leads again: its console file is gone and its own console device left the data (A withdrew it when it booted to lead)', left.files.length === 0 && !left.devices.includes(`console-${HOST_KEY_A}`), JSON.stringify(left))
    return c
  } finally {
    if (stoppedB) try { process.kill(stoppedB, 'SIGCONT') } catch { /* gone */ }
    await replay.stop().catch(() => {})
    fs.writeFileSync(path.join(root, 'mac-app-replay.jsonl'), appLog.join('\n') + '\n')
    await cw.stop()
  }
}
