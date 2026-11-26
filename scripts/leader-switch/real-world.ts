/**
 * Rehearsal (b)'s world (docs/reference/leader-switch.md, "Rehearsal (b)"): machine B on ANOTHER computer, A, H and
 * the companion here in the dev container, every link between the two an ssh tunnel (transport.ts), synthetic
 * homes only. It is remote-world.ts's world with B's placement: B's processes run there through machine-agent.ts,
 * started over one ssh channel, and every read of B's files runs there; the links and their cuts stay proxies here.
 *
 * What it does on the other machine, in order (each a script of real/ run there, or the agent):
 *
 *   1. preflight.sh   read only: cores, load, free memory and disk, glibc, whether the root exists, its clock.
 *                     Refused below the stated limits (LIMITS); a large-home run is cut to the small-data scenarios
 *                     when only its own disk limit fails, and the run says so.
 *   2. snapshot.sh    this account's processes there that are not the rehearsal's, kept to compare during the run
 *                     (every minute: a changed service ends the run at once, cleanup first) and after it.
 *   3. make-root.sh   the root, fresh and owner only, with refusing stand-ins for crontab, systemctl, ssh, claude.
 *   4. staging        the tree of the commit (`git archive`), its dist (the daemon binary of that platform, the web
 *                     build), its node_modules (search's models left out), and this Bun, by `tar` over ssh into the root.
 *   5. the agent      `cd <root>/code && exec env -i <machine env> <root>/bin/bun scripts/leader-switch/machine-agent.ts`:
 *                     every place of its env inside the root. It starts B's daemon and host service and runs the
 *                     operations the scenarios ask for.
 *   6. tunnels        through the master's control socket, each at the same port on both machines (transport.ts).
 *   7. cleanup.sh     at every end (also after a failure, a signal, or a changed production process): every process
 *                     of the rehearsal there by pid (its cwd or program under the root, started after the root was
 *                     made), then the root; then the snapshot again, compared with the first.
 *
 * The FakeTransport runs the same steps against a folder of this computer: the driver's own test, with no other
 * machine (`--real-fake <dir>`).
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { buildRemoteWorld, type BPlacement, type MachineDaemon, type RemoteWorld, type WorldOptions } from './remote-world.js'
import { describeMachine, REPO } from './world.js'
import { AgentIO, registerMachineRoot } from './machine-io.js'
import { shq, type ShResult, type Transport } from './transport.js'

const REAL = path.join(REPO, 'scripts', 'leader-switch', 'real')
const script = (name: string) => fs.readFileSync(path.join(REAL, name), 'utf8')
const GIB = 1024 ** 3

/**
 * The limits a run needs on the other machine (it runs a production host service, and is small):
 *   load       its 1-minute load below its core count, else no run at all
 *   memory     at least 3 GiB available (MemAvailable), else no run at all
 *   disk       at least 3 times the data the run puts there: about 3 GiB for the small-data scenarios (the staged
 *              tree with its node_modules, the homes, standby-behind's 1.2 GB), else no run at all; with `--gb N`,
 *              3 GiB + 2 N GiB (the copy of the filler and the home it becomes): when that is not there the run
 *              goes on without the filler, the small-data scenarios only, and says so
 */
export const LIMITS = { memAvailGib: 3, smallDataGib: 3, diskFactor: 3 } as const

export interface Facts { [k: string]: string }

/** What the preflight allows: refused (why), or a run, small-data only (why) or as asked. */
export function judgeFacts(f: Facts, gb: number): { refused: string | null; smallOnly: string | null; needGib: number } {
  const nproc = Number(f.nproc)
  const load = Number(f.load1)
  const mem = Number(f.mem_avail_kb) * 1024
  const disk = Number(f.disk_avail_kb) * 1024
  const small = LIMITS.diskFactor * LIMITS.smallDataGib * GIB
  const large = LIMITS.diskFactor * (LIMITS.smallDataGib + 2 * gb) * GIB
  const fmt = (b: number) => `${(b / GIB).toFixed(1)} GiB`
  if (f.root_exists === 'yes') return { refused: `the root exists there (an earlier run's?): clean it first (real/cleanup.sh)`, smallOnly: null, needGib: 0 }
  if (!Number.isFinite(nproc) || !Number.isFinite(load) || load >= nproc) return { refused: `load ${f.load1} is not below its ${f.nproc} cores`, smallOnly: null, needGib: 0 }
  if (!Number.isFinite(mem) || mem < LIMITS.memAvailGib * GIB) return { refused: `${fmt(mem)} of memory available, under ${LIMITS.memAvailGib} GiB`, smallOnly: null, needGib: 0 }
  if (!Number.isFinite(disk) || disk < small) return { refused: `${fmt(disk)} of disk free, under ${fmt(small)} (3 x ${LIMITS.smallDataGib} GiB)`, smallOnly: null, needGib: 0 }
  if (gb > 0 && disk < large) return { refused: null, smallOnly: `${fmt(disk)} of disk free, under ${fmt(large)} (3 x (${LIMITS.smallDataGib} + 2 x ${gb}) GiB) for --gb ${gb}: no filler, small-data scenarios only`, needGib: large / GIB }
  return { refused: null, smallOnly: null, needGib: (gb > 0 ? large : small) / GIB }
}

export const parseFacts = (out: string): Facts => Object.fromEntries(out.split('\n').map((l) => l.trim()).filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))

/** The production processes of a snapshot that are services (pid and start tick), for the during-run comparison. */
export const servicesOf = (snap: string): string[] => snap.split('\n').map((l) => l.trim().split(' ')).filter((f) => f[2] === 'service').map((f) => `${f[0]} ${f[1]} ${f.slice(3).join(' ')}`)

export class RealRefused extends Error {}

/**
 * The fake transport's guard: B's root is a folder of this computer there, so a check that reads a B path itself
 * (instead of through the agent) would still pass, and fail only on the real machine. Every call of this process's
 * `fs` with a path under `root` is recorded (with where it came from), and the run fails when there is one. In (b)
 * proper the path does not exist here, and the check fails by itself.
 */
export function watchLocalAccess(root: string): { hits: () => string[]; stop: () => void } {
  const r = path.resolve(root)
  const hits: string[] = []
  const under = (p: unknown) => {
    const s = typeof p === 'string' ? p : p instanceof URL ? p.pathname : Buffer.isBuffer(p) ? p.toString() : null
    return !!s && (path.resolve(s) === r || path.resolve(s).startsWith(`${r}${path.sep}`))
  }
  const restore: Array<() => void> = []
  const wrap = (obj: Record<string, unknown>, names: string[], label: string) => {
    for (const n of names) {
      const orig = obj[n]
      if (typeof orig !== 'function') continue
      obj[n] = function (this: unknown, ...a: unknown[]) {
        if ((under(a[0]) || under(a[1])) && hits.length < 50) hits.push(`${label}.${n}(${String(a[0])}) at ${new Error().stack?.split('\n').slice(2, 5).map((l) => l.trim()).join(' < ')}`)
        return (orig as (...x: unknown[]) => unknown).apply(this, a)
      }
      restore.push(() => { obj[n] = orig })
    }
  }
  wrap(fs as unknown as Record<string, unknown>, ['readFileSync', 'writeFileSync', 'appendFileSync', 'existsSync', 'readdirSync', 'statSync', 'lstatSync', 'openSync', 'renameSync', 'rmSync', 'mkdirSync', 'chmodSync', 'readlinkSync', 'accessSync', 'createReadStream', 'createWriteStream', 'readFile', 'writeFile', 'readdir', 'stat', 'lstat', 'open', 'rename', 'rm', 'mkdir', 'access'], 'fs')
  wrap(fs.promises as unknown as Record<string, unknown>, ['readFile', 'writeFile', 'appendFile', 'readdir', 'stat', 'lstat', 'open', 'rename', 'rm', 'mkdir', 'access', 'chmod', 'readlink'], 'fs.promises')
  return { hits: () => [...hits], stop: () => { for (const f of restore.splice(0)) f() } }
}

export interface RealOptions extends WorldOptions {
  transport: Transport
  /** B's rehearsal root there (an absolute folder there, made fresh). */
  bRoot: string
  /** Where the evidence goes (the snapshots, the cleanup's output). */
  evidence: string
  /** `--gb N` as asked: judged against the disk there. */
  fillerGb?: number
  /** Keep B's root at the end (cleanup still ends every process). */
  keepRoot?: boolean
  /** Folders whose processes are not the other machine's production (the FakeTransport's test: this computer's rehearsal). */
  notProduction?: string[]
  /** Called once the root there is made, with what ends the run there (for a stop before the world is built: a signal, a changed production process). */
  onStop?: (stop: () => Promise<void>) => void
  /** Called when a production process there changed during the run (the run stops). */
  onProductionChange?: (why: string) => void
}

export interface RealWorld extends RemoteWorld {
  /** What the preflight read there, and what it allowed. */
  facts: Facts
  /** The commit staged there. */
  commit: string
  /** The cleanup's output there (after stop). */
  cleanupOut: () => string
  /** The fake transport only: this process's own reads and writes of B's files (none: every one goes through the agent). */
  localAccess: () => string[]
  /** The ports B's processes listened on, sampled every minute and at the stop: how many samples, and each one not on loopback. */
  listeners: () => { samples: number; seen: number; open: string[] }
}

async function must(r: Promise<ShResult>, what: string): Promise<ShResult> {
  const x = await r
  if (x.code !== 0) throw new Error(`${what} failed (exit ${x.code}): ${(x.err || x.out).trim().slice(-1500)}`)
  return x
}

/** `tar -c` of `args` in REPO as a stream (its stderr kept for the message). */
function tarOut(args: string[]) {
  const p = spawn('tar', ['-c', '-C', REPO, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
  return p.stdout
}

export async function makeRealWorld(root: string, opts: RealOptions): Promise<RealWorld> {
  const t = opts.transport
  const log = opts.log ?? (() => {})
  const R = opts.bRoot.replace(/\/+$/, '')
  if (!path.isAbsolute(R) || R.split('/').filter(Boolean).length < 2) throw new RealRefused(`the root there must be an absolute folder at least two levels deep, not ${opts.bRoot}`)
  fs.mkdirSync(opts.evidence, { recursive: true })
  const evidence = (name: string, text: string) => fs.writeFileSync(path.join(opts.evidence, name), text)
  const commit = execFileSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()

  // 1. What is there, read only.
  const pre = await must(t.sh(script('preflight.sh'), { args: [R], timeoutMs: 60_000 }), 'preflight there')
  const facts = parseFacts(pre.out)
  evidence('preflight.txt', pre.out)
  const judged = judgeFacts(facts, opts.fillerGb ?? 0)
  log(`preflight on ${t.label}: ${JSON.stringify(facts)}; ${judged.refused ? `REFUSED: ${judged.refused}` : judged.smallOnly ? `SMALL DATA ONLY: ${judged.smallOnly}` : 'ok'}`)
  if (judged.refused) throw new RealRefused(`${t.label}: ${judged.refused}; nothing was made there`)

  // 2. Its production processes before.
  const before = await must(t.sh(script('snapshot.sh'), { args: [R, ...(opts.notProduction ?? [])], timeoutMs: 60_000 }), 'snapshot there')
  evidence('procs-before.txt', before.out)
  const servicesBefore = servicesOf(before.out)

  // 3. The root.
  const runId = `${new Date().toISOString()}-${randomBytes(3).toString('hex')}`
  log((await must(t.sh(script('make-root.sh'), { args: [R, runId], timeoutMs: 60_000 }), 'make-root there')).out.trim())
  let agent: AgentIO | null = null
  let unregister = () => {}
  let watcher: NodeJS.Timeout | null = null
  let follower: NodeJS.Timeout | null = null
  let cleanupOut = ''
  let stopped = false
  // Every port a process of the run there listened on not on its loopback (machine-ops.ts listenersUnder).
  const listen = { samples: 0, seen: new Set<string>(), open: new Set<string>() }
  const sampleListeners = async () => {
    if (!agent || agent.endedWhy) return
    const ls = await agent.op('listenersUnder', R).catch(() => null)
    if (!ls) return
    listen.samples++
    for (const l of ls) {
      listen.seen.add(l.addr)
      if (!/^(127\.\d+\.\d+\.\d+|\[::1\]|\[::ffff:127\.\d+\.\d+\.\d+\]):\d+$/.test(l.addr)) listen.open.add(`${l.addr} (pid ${l.pid}: ${l.cmd})`)
    }
  }
  const stopThere = async (): Promise<void> => {
    if (stopped) return
    stopped = true
    if (watcher) clearInterval(watcher)
    if (follower) clearInterval(follower)
    await sampleListeners()
    evidence('listeners.txt', `${listen.samples} sample(s); seen ${[...listen.seen].sort().join(' ')}\nnot on loopback: ${[...listen.open].join('\n') || 'none'}\n`)
    await agent?.close().catch(() => {})
    unregister()
    // Every process of the rehearsal there, by pid, then the root.
    const c = await t.sh(script('cleanup.sh'), { args: [R, ...(opts.keepRoot ? ['--keep-root'] : [])], timeoutMs: 180_000 }).catch((err: Error) => ({ code: -1, out: '', err: err.message }))
    cleanupOut = `${c.out}${c.err ? `\n[stderr] ${c.err}` : ''}\n[exit ${c.code}]\n`
    evidence('cleanup.txt', cleanupOut)
    log(`cleanup on ${t.label}: exit ${c.code}`)
    const after = await t.sh(script('snapshot.sh'), { args: [R, ...(opts.notProduction ?? [])], timeoutMs: 60_000 }).catch(() => null)
    if (after) {
      evidence('procs-after.txt', after.out)
      evidence('procs-diff.txt', diffLines(before.out, after.out))
    }
    await t.close({ master: true }).catch(() => {})
    guard?.stop()
    if (guard?.hits().length) evidence('local-access.txt', `${guard.hits().join('\n')}\n`)
  }
  opts.onStop?.(stopThere)
  // From here every read of B's files is the agent's (the fake transport: B's root is a folder here, watched).
  const guard = t.sharedLoopback ? watchLocalAccess(R) : null
  try {
    // 4. The code of this commit, its build and its packages, and this Bun.
    // The commit's tree (rehearsal (b) runs only a clean tree whose commit is on trunk: the CLI refuses any other). The
    // fake transport's test of a tree with changes stages what is in it: every tracked and new file, as it is.
    const dirty = execFileSync('git', ['-C', REPO, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' }).trim() !== ''
    if (dirty && !t.sharedLoopback) throw new RealRefused(`the tree has changes: ${t.label} runs only the commit ${commit} as it is`)
    const tree = dirty
      ? spawn('sh', ['-c', 'git ls-files -z --cached --others --exclude-standard | xargs -0 sh -c \'for f; do [ -e "$f" ] && printf "%s\\0" "$f"; done\' sh | tar -c --null -T -'], { cwd: REPO, stdio: ['ignore', 'pipe', 'inherit'] }).stdout
      : spawn('git', ['-C', REPO, 'archive', '--format=tar', commit], { stdio: ['ignore', 'pipe', 'inherit'] }).stdout
    await must(t.sh(`tar -x -C ${shq(`${R}/code`)}`, { input: tree, timeoutMs: 600_000 }), 'staging the tree')
    await must(t.sh(`tar -x -C ${shq(`${R}/code`)}`, { input: tarOut(['--exclude=*.map', `--exclude=dist/daemon-binaries/daemon-darwin-*`, `--exclude=dist/daemon-binaries/daemon-linux-arm64*`, 'dist']), timeoutMs: 900_000 }), 'staging dist')
    await must(t.sh(`tar -x -C ${shq(`${R}/code`)}`, { input: tarOut(['--exclude=node_modules/.cache', '--exclude=node_modules/onnxruntime-node', '--exclude=node_modules/onnxruntime-web', '--exclude=node_modules/@huggingface', '--exclude=node_modules/playwright-core/.local-browsers', 'node_modules']), timeoutMs: 1_800_000 }), 'staging node_modules')
    await must(t.sh(`cat > ${shq(`${R}/bin/bun`)} && chmod 755 ${shq(`${R}/bin/bun`)} && ${shq(`${R}/bin/bun`)} --version`, { input: fs.createReadStream(process.execPath), timeoutMs: 300_000 }), 'staging bun')
    log(`staged ${dirty ? `the working tree on commit ${commit} (changed files as they are)` : `commit ${commit}`} in ${R}/code on ${t.label}`)

    // 5. The agent: B's hands there, every place of its env inside the root.
    const bDir = `${R}/machine`
    const agentEnv: Record<string, string> = {
      HOME: bDir, USERPROFILE: bDir, TMPDIR: `${R}/tmp`, LANG: 'C.UTF-8',
      XDG_STATE_HOME: `${bDir}/.local/state`, XDG_DATA_HOME: `${bDir}/.local/share`, XDG_CONFIG_HOME: `${bDir}/.config`, XDG_CACHE_HOME: `${bDir}/.cache`,
      PATH: `${R}/bin:/usr/local/bin:/usr/bin:/bin`, NODE_EXTRA_CA_CERTS: `${R}/tls/cert.pem`,
      WALNUT_REHEARSAL_ROOT: R, WALNUT_REHEARSAL_PIDS: `${R}/run/pids.jsonl`,
    }
    const envWords = Object.entries(agentEnv).map(([k, v]) => shq(`${k}=${v}`)).join(' ')
    const agentProc = t.spawn(`mkdir -p ${shq(bDir)} && cd ${shq(`${R}/code`)} && exec env -i ${envWords} ${shq(`${R}/bin/bun`)} scripts/leader-switch/machine-agent.ts`)
    const agentLog = fs.createWriteStream(path.join(opts.evidence, 'agent.log'), { flags: 'a' })
    agent = new AgentIO(t.label, agentProc, (s) => agentLog.write(`${new Date().toISOString()} ${s}\n`))
    const hello = await Promise.race([agent.hello, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('no hello from the agent within 120 s')), 120_000))])
    log(`agent on ${t.label}: ${JSON.stringify(hello)}`)
    const io = agent
    unregister = registerMachineRoot(R, io)

    // Its clock and the link's round trip (an op through the agent, and an ssh command), five each.
    const times: Record<string, string> = {}
    const skews: number[] = []
    const rtts: number[] = []
    for (let i = 0; i < 5; i++) {
      const t0 = Date.now()
      const there = await io.op('now')
      const t1 = Date.now()
      skews.push(there - (t0 + t1) / 2)
      rtts.push(t1 - t0)
    }
    const shRtt: number[] = []
    for (let i = 0; i < 5; i++) { const t0 = Date.now(); await t.sh('true'); shRtt.push(Date.now() - t0) }
    const med = (xs: number[]) => [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)]!
    times[`clock of ${t.label} minus this computer's (median of 5, agent round trip ${med(rtts)} ms)`] = `${med(skews).toFixed(0)} ms`
    times[`an ssh command's round trip to ${t.label} (median of 5)`] = `${med(shRtt)} ms`

    // B, its folder there.
    const b = describeMachine(bDir, 'b', opts.portB)
    await io.op('mkdir', bDir)
    await io.op('write', b.idFile, `${b.id}\n`)
    // The stand-in HOMEs a route's probe runs with (daemon-routes.ts runRemoteScript): B's of its hosts, A's of B.
    for (const id of ['machine-a', 'machine-h']) await io.op('mkdir', `${bDir}/hosts/${id}`)
    fs.mkdirSync(path.join(root, 'machines', 'hosts', b.id), { recursive: true })

    // 2b. Its production services, every minute: a change ends the run (the caller stops, cleanup first).
    watcher = setInterval(() => {
      void sampleListeners()
      void t.sh(script('snapshot.sh'), { args: [R, ...(opts.notProduction ?? [])], timeoutMs: 60_000 }).then((now) => {
        if (now.code !== 0 || stopped) return
        const s = servicesOf(now.out)
        const gone = servicesBefore.filter((x) => !s.includes(x))
        const added = s.filter((x) => !servicesBefore.includes(x))
        if (gone.length || added.length) {
          evidence('procs-changed.txt', now.out)
          opts.onProductionChange?.(`a production process on ${t.label} changed during the run: gone [${gone.join('; ')}], new [${added.join('; ')}]`)
        }
      }).catch(() => {})
    }, 60_000)

    // The copy link follows B's daemon port as it moves (a server taking the daemon in process): read there every second.
    const followed = new Map<string, number>()
    const forwarded = new Set<number>()
    // Each tunnel, as it is opened (the evidence names every port the run opened there).
    const tunnel = (line: string) => fs.appendFileSync(path.join(opts.evidence, 'tunnels.txt'), `${new Date().toISOString()} ${line}\n`)
    const forward = async (port: number) => { if (forwarded.has(port)) return; forwarded.add(port); await t.forward(port); tunnel(`forward ${port}: this computer's 127.0.0.1:${port} to ${t.label}'s 127.0.0.1:${port} (nothing listens there for it)`) }
    const place: BPlacement = {
      kind: 'two-machines', label: t.label, wayC: false, b, io,
      basePath: agentEnv.PATH!,
      // Every server of B listens on its loopback only (a server's default is every interface: web/bind-address.ts).
      envExtra: { WALNUT_BIND_ADDRESS: '127.0.0.1', TMPDIR: agentEnv.TMPDIR!, XDG_STATE_HOME: agentEnv.XDG_STATE_HOME!, XDG_DATA_HOME: agentEnv.XDG_DATA_HOME!, XDG_CONFIG_HOME: agentEnv.XDG_CONFIG_HOME!, XDG_CACHE_HOME: agentEnv.XDG_CACHE_HOME! },
      certOnB: async (cert) => { const f = `${R}/tls/cert.pem`; await io.op('write', f, fs.readFileSync(cert.certFile, 'utf8')); return f },
      routeHomeOnB: (id) => `${bDir}/hosts/${id}`,
      routeHomeOfB: path.join(root, 'machines', 'hosts', b.id),
      // Each machine's own walnut program (its daemon's bin, machine-ops.ts writeBin): the paths differ between the two.
      walnut: ['walnut-rehearsal'],
      forward, reverse: async (p) => { await t.reverse(p); tunnel(`reverse ${p}: ${t.label}'s 127.0.0.1:${p} (a listener there) to this computer's 127.0.0.1:${p}`) },
      daemonPort: (d: MachineDaemon) => {
        followed.set(d.dir, d.port)
        if (!follower) {
          follower = setInterval(() => {
            for (const [dir, cur] of followed) {
              void io.op('daemonPort', dir).then(async (p) => { if (p && p !== cur) { await forward(p); followed.set(dir, p) } }).catch(() => {})
            }
          }, 1_000)
        }
        return () => followed.get(d.dir) ?? d.port
      },
      times,
      stop: stopThere,
    }
    const w = await buildRemoteWorld(root, opts, place)
    return Object.assign(w, { facts, noFiller: judged.smallOnly, commit: dirty ? `${commit} with the working tree's changes` : commit, cleanupOut: () => cleanupOut, localAccess: () => guard?.hits() ?? [], listeners: () => ({ samples: listen.samples, seen: listen.seen.size, open: [...listen.open] }) })
  } catch (err) {
    await stopThere()
    throw err
  }
}

/** Lines in `a` and not in `b` (-), and in `b` and not in `a` (+). */
function diffLines(a: string, b: string): string {
  const la = a.split('\n').filter(Boolean)
  const lb = b.split('\n').filter(Boolean)
  const out = [...la.filter((l) => !lb.includes(l)).map((l) => `- ${l}`), ...lb.filter((l) => !la.includes(l)).map((l) => `+ ${l}`)]
  return out.length ? `${out.join('\n')}\n` : '(the same)\n'
}
