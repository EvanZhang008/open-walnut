/**
 * The leader-switch rehearsal on one Linux dev box (docs/reference/leader-switch.md,
 * "Rehearsal"): real servers on synthetic homes, three local witnesses, the real
 * `walnut leader switch` command. Prints one line per check; exits 1 when one fails.
 *
 *   bun scripts/leader-switch-rehearsal.ts <work dir> [--gb N] [--kills] [--stops] [--trials] [--flag-off (also: on with no witnesses)] [--restarts] [--paths] [--console [--as-installed] [--away-seconds N]] [--all] [--keep]
 *   bun scripts/leader-switch-rehearsal.ts <work dir> --remote [--only <scenario,...>] [--gb N [--filler tracked|ignored]] [--in-process-daemon default|off] [--git-watch <log>] [--keep]
 *   bun scripts/leader-switch-rehearsal.ts <work dir> --remote --real <host> --real-socket <ssh control socket> --real-root <folder there> [--real-evidence <dir>] [--keep-real-root] [the --remote flags]
 *   bun scripts/leader-switch-rehearsal.ts <work dir> --remote --real-fake <folder here> [--real-evidence <dir>] [--keep-real-root] [the --remote flags]
 *
 * Without a scenario flag it runs the main one: A leads, a standby copy to B, load through
 * A's API, the switch to B, every check, A started again by hand (online and offline), writes
 * on B, the switch back; then a home moved to another HOME prefix (`--paths` runs only that). `--gb N` puts N GB of filler in A's home first (the downtime of a
 * real-sized home; the first standby batch of 20 GB takes about 20 minutes). `--kills` kills
 * the command at each step and resumes it (`--no-back`: no switch back, for a large home on a full disk); `--trials` breaks the copy three ways.
 * `--stops` runs the switch stop's cases (leader-switch/stop-rehearsal.ts): a writer after the first final batch, a
 * signal and a kill during it, the old leader's own cancel when no stop comes, a launcher that restarts the home, `--status`.
 * `--console` runs the old leader's console after the switch (leader-switch/console-rehearsal.ts):
 * the Mac app's handling replayed the whole time, B cut off for `--away-seconds` (default 60),
 * A's home checked by its manifest classes; `--as-installed` keeps A's daemon state where an
 * installed one does (inside the home). It needs the built app (`bun run build`). Everything
 * stays inside <work dir>; nothing reads ~/.open-walnut or uses :3456.
 * `--remote` is rehearsal (a) of the switch between machines (leader-switch/remote-rehearsal.ts): three
 * machines with their own HOME, machine id and real daemon, the companion, every link a proxy the run cuts
 * or slows; it is not part of `--all` (`--only` picks scenarios, `--gb N` the size for the downtime runs). It runs
 * the default configuration (each server runs its machine's daemon in its own process, experiment
 * `in_process_daemon`); `--in-process-daemon off` pins the daemon program of its own (the legacy shape).
 * The header and every TIME line name the setting. `--git-watch <log>` (diagnostics) puts a git shim first on every
 * machine's PATH and logs each git on a machine's home there, and who wrote a home's empty tree object (leader-switch/git-watch.ts).
 * `--real <host>` is rehearsal (b) (leader-switch/real-world.ts): the same scenarios with machine B on that host, every
 * link an ssh tunnel through the control socket of a master connection a person opened on the clouddev host
 * (leader-switch/real/ssh-master.sh), B's root `--real-root` made fresh there and removed at the end
 * (`--keep-real-root` keeps it; every process of the run there is ended either way). It runs only a clean tree whose
 * commit is on trunk. `--real-fake <folder>` runs the same driver with B in `<folder>/b2b-real` on this computer (the
 * driver's own test: no other machine, any commit). With `--real-confined` (only with `--real-fake`) it then lists every
 * file of this computer created or changed during the run outside B's root and A's own places (the work dir, the
 * evidence, the driver's HOME and TMPDIR, which must then be folders of their own): B's environment writes nothing
 * outside its root, or the check fails naming what it wrote.
 */
import fs from 'node:fs'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { rehearseConsole } from './leader-switch/console-rehearsal.js'
import { rehearseLateWriter, rehearseLauncherRace, rehearseServerKilledInFinalBatch, rehearseSignalInFinalBatch, rehearseStopWait } from './leader-switch/stop-rehearsal.js'
import { KILL_POINTS, TRIAL_FAILURES, rehearseCancel, rehearseCancelAfterCommit, rehearseFlagOff, rehearseHomePrefix, rehearseNoWitnesses, rehearseRestart, rehearseLedgerControl, rehearseKill, rehearseSwitchAndBack, rehearseTrialFailure, type Check } from './leader-switch/rehearsal.js'

const args = process.argv.slice(2)
const root = args[0]
if (!root || root.startsWith('--')) {
  console.error('usage: bun scripts/leader-switch-rehearsal.ts <work dir> [--gb N [--filler tracked|ignored]] [--kills] [--stops] [--trials] [--flag-off] [--restarts] [--paths] [--console] [--all] [--no-back] [--port-base N] [--keep]')
  process.exit(2)
}
const has = (f: string) => args.includes(f)
const gbAt = args.indexOf('--gb')
const gb = gbAt >= 0 ? Number(args[gbAt + 1]) : 0
// The large filler under artifacts/ (git tracks it: the pressure case) or voice-archive/ (git ignores it).
const fillerAt = args.indexOf('--filler')
const filler = fillerAt >= 0 ? args[fillerAt + 1] : 'tracked'
if (filler !== 'tracked' && filler !== 'ignored') { console.error('--filler is tracked or ignored'); process.exit(2) }
const all = has('--all')
// What ran, first in the log: its commit and whether the tree had changes beside it (an evidence log names its code).
{
  const repo = path.resolve(import.meta.dirname, '..')
  const git = (a: string[]) => { try { return execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' }) } catch { return '' } }
  const changed = git(['status', '--porcelain', '--untracked-files=no']).split('\n').filter((l) => l.trim())
  console.log(`REHEARSAL  commit ${git(['rev-parse', 'HEAD']).trim() || 'unknown'}, tree ${changed.length ? `with ${changed.length} changed file(s): ${changed.slice(0, 5).map((l) => l.slice(3)).join(', ')}` : 'clean'}; args ${args.slice(1).join(' ')}; in_process_daemon ${process.env.WALNUT_IN_PROCESS_DAEMON === '1' || process.env.WALNUT_IN_PROCESS_DAEMON === '0' ? `forced ${process.env.WALNUT_IN_PROCESS_DAEMON === '1'} by WALNUT_IN_PROCESS_DAEMON` : 'as each rehearsal config says (default true)'}; ${new Date().toISOString()}`)
}
const work = path.resolve(root, new Date().toISOString().replace(/[:.]/g, '-'))
fs.mkdirSync(work, { recursive: true })

let failed = 0
const print = (c: Check) => {
  if (!c.ok) failed++
  console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? `  (${c.detail})` : ''}`)
}
const log = (s: string) => { if (process.env.REHEARSAL_VERBOSE) console.log(s) }

const baseAt = args.indexOf('--port-base')
let port = baseAt >= 0 ? Number(args[baseAt + 1]) : 4800
const ports = () => { port += 2; return { portA: port, portB: port + 1 } }

if (has('--remote')) {
  const { rehearseRemote } = await import('./leader-switch/remote-rehearsal.js')
  const real = await realWorld()
  const onlyAt = args.indexOf('--only')
  const ipdAt = args.indexOf('--in-process-daemon')
  const ipd = ipdAt >= 0 ? args[ipdAt + 1] : 'default'
  if (ipd !== 'default' && ipd !== 'off') { console.error('--in-process-daemon default|off'); process.exit(2) }
  const { inProcessDaemonLabel } = await import('./leader-switch/remote-world.js')
  // Every result of this run is under this setting: the header says it, and so does every measured line.
  console.log(`REMOTE  under ${inProcessDaemonLabel(ipd)}`)
  const r = await rehearseRemote(path.join(work, 'remote'), print, { portA: port + 2, portB: port + 3, fillerGb: gb, filler, log, inProcessDaemon: ipd, ...(args.includes('--git-watch') ? { gitWatch: path.resolve(String(args[args.indexOf('--git-watch') + 1])) } : {}), ...(onlyAt >= 0 ? { only: String(args[onlyAt + 1]).split(',') } : {}), ...(real ? { world: real.make, onWorld: real.onWorld } : {}) })
  for (const n of r.notes) console.log(`NOTE  ${n}`)
  for (const [k, v] of Object.entries(r.times)) console.log(`TIME  ${k}: ${v} (under ${r.inProcessDaemon})`)
  real?.after()
  finish()
}

/**
 * `--real <host>` / `--real-fake <folder>`: rehearsal (b)'s world (real-world.ts), and what the run prints and checks
 * of the other machine itself once it ended: its cleanup there, and its production processes before and after.
 * A changed production process there, SIGINT or SIGTERM: the world is stopped (cleanup there first) and the run ends.
 */
async function realWorld(): Promise<{ make: import('./leader-switch/remote-rehearsal.js').MakeWorld; onWorld: (w: import('./leader-switch/remote-world.js').RemoteWorld) => void; after: () => void } | null> {
  const flag = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined }
  const host = flag('--real')
  const fakeDir = flag('--real-fake')
  if (!host && !fakeDir) return null
  const { makeRealWorld, RealRefused } = await import('./leader-switch/real-world.js')
  const { FakeTransport, SshTransport } = await import('./leader-switch/transport.js')
  const repo = path.resolve(import.meta.dirname, '..')
  const git = (a: string[]) => { try { return execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' }).trim() } catch { return '' } }
  const commit = git(['rev-parse', 'HEAD'])
  let transport
  let bRoot: string
  if (host) {
    // The other machine runs only a commit that is on trunk, from a clean tree.
    const dirty = git(['status', '--porcelain', '--untracked-files=no'])
    const onTrunk = (() => { try { execFileSync('git', ['-C', repo, 'merge-base', '--is-ancestor', commit, 'refs/trunk/main']); return true } catch { return false } })()
    if (dirty || !onTrunk) { console.error(`--real: refused: the commit ${commit} ${dirty ? 'has a changed tree' : 'is not on trunk (refs/trunk/main)'}; the other machine runs only a landed commit`); process.exit(2) }
    const socket = flag('--real-socket')
    bRoot = flag('--real-root') ?? ''
    if (!socket || !bRoot) { console.error('--real <host> needs --real-socket <the master\'s control socket> and --real-root <the folder there>'); process.exit(2) }
    const ssh = new SshTransport({ host, socket })
    const up = await ssh.check()
    if (!up.ok) { console.error(`--real: no ssh master for ${host} at ${socket} (${up.why}). On the clouddev host: sh scripts/leader-switch/real/ssh-master.sh open ${host} ${socket}`); process.exit(2) }
    transport = ssh
  } else {
    bRoot = path.join(path.resolve(fakeDir!), 'b2b-real')
    transport = new FakeTransport()
  }
  // The other machine's own evidence (its preflight, process snapshots, the agent's log, the cleanup's output): a
  // folder that outlives the dev container (`--real-evidence`), else beside the run.
  const evidence = path.resolve(flag('--real-evidence') ?? path.join(work, 'real'), path.basename(work))
  console.log(`REAL  B on ${transport.label}, its root ${bRoot}; commit ${commit}${host ? ' (on trunk)' : ' (the driver\'s own test: any commit)'}; way c off: after w-b's one-time setup over a setup-only link, A is to reach w-b only through its door (the boot check holds it); evidence ${evidence}`)
  // `--real-confined`: the time before anything of B starts, and A's own places (each a folder of its own).
  const confined = has('--real-confined')
  const marker = path.join(work, 'confined-since')
  const aPlaces = [path.resolve(work), evidence, path.resolve(process.env.HOME ?? '/'), path.resolve(os.tmpdir())]
  if (confined) {
    if (host) { console.error('--real-confined runs only with --real-fake (it lists the files of this computer)'); process.exit(2) }
    const shallow = aPlaces.filter((p) => p.split('/').filter(Boolean).length < 2)
    if (shallow.length) { console.error(`--real-confined: HOME and TMPDIR must be folders of their own for this run (not ${shallow.join(', ')}): set them, e.g. HOME=/tmp/rb-a-home TMPDIR=/tmp/rb-a-tmp`); process.exit(2) }
    fs.writeFileSync(marker, '')
  }
  // `--real-confined`: this driver's own children (the companion, the TLS fronts' helpers: A's side, which in (b)
  // runs in the dev container), every few seconds, to tell their lines in a machine-wide file from B's.
  const aChildren = new Map<number, string>()
  const childTimer = confined ? setInterval(() => {
    for (const d of (() => { try { return fs.readdirSync('/proc') } catch { return [] } })()) {
      if (!/^\d+$/.test(d) || aChildren.has(Number(d))) continue
      try {
        const stat = fs.readFileSync(`/proc/${d}/stat`, 'utf8')
        if (Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]) === process.pid) aChildren.set(Number(d), fs.readFileSync(`/proc/${d}/cmdline`, 'utf8').split('\0').join(' ').slice(0, 160))
      } catch { /* gone */ }
    }
  }, 2_000) : null
  childTimer?.unref()
  let world: Awaited<ReturnType<typeof makeRealWorld>> | null = null
  // Until the world is built, what ends the run on the other machine (its cleanup), once its root is made.
  let stopThere: (() => Promise<void>) | null = null
  let ending = false
  const abort = async (why: string, code: number) => {
    if (ending) return
    ending = true
    console.log(`ABORT  ${why}: stopping the world (cleanup there first)`)
    failed++
    // The other machine first (its agent, its cleanup, its snapshot, the ssh master), then A's side here.
    const capped = (p: Promise<unknown> | undefined, ms: number) => Promise.race([p, new Promise((r) => setTimeout(r, ms))]).catch(() => {})
    await capped(stopThere?.(), 600_000)
    if (world) await capped(world.stop(), 120_000)
    const out = (() => { try { return fs.readFileSync(path.join(evidence, 'cleanup.txt'), 'utf8') } catch { return 'none ran (nothing was made there)' } })()
    console.log(`REAL  cleanup there:\n${out.trim()}`)
    makeWritable(work)
    process.exit(code)
  }
  // An error nothing caught ends the run the same way: the other machine is cleaned up before this process goes.
  process.on('uncaughtException', (err) => { console.error(err); void abort(`an uncaught error: ${err instanceof Error ? err.message : String(err)}`, 1) })
  process.on('unhandledRejection', (err) => { console.error(err); void abort(`an unhandled rejection: ${err instanceof Error ? err.message : String(err)}`, 1) })
  process.on('SIGINT', () => { void abort('SIGINT', 130) })
  process.on('SIGTERM', () => { void abort('SIGTERM', 143) })
  return {
    make: async (root, o) => {
      try {
        world = await makeRealWorld(root, { ...o, transport, bRoot, evidence, fillerGb: gb, keepRoot: has('--keep-real-root'),
          ...(host ? {} : { notProduction: [repo, path.resolve(work)] }),
          onStop: (stop) => { stopThere = stop },
          onProductionChange: (why) => { void abort(why, 3) } })
        return world
      } catch (err) {
        if (err instanceof RealRefused) { console.log(`FAIL  real: the other machine allows the run  (${err.message})`); failed++; finish() }
        throw err
      }
    },
    onWorld: () => {},
    after: () => {
      if (!world) return
      const out = world.cleanupOut()
      print({ name: `real: the cleanup on ${transport.label} ended every process of the run there by pid${has('--keep-real-root') ? '' : ' and removed its root'}`, ok: /\[exit 0\]\s*$/.test(out), detail: out.trim().split('\n').filter((l) => /^(TERM|KILL|LEFT|cleanup:)/.test(l)).slice(-6).join(' | ') })
      if (!host) {
        const hits = world.localAccess()
        print({ name: 'real-fake: the driver never read or wrote a file of B itself (each one through the agent, as over ssh)', ok: hits.length === 0, detail: hits.length ? hits.slice(0, 3).join(' | ') : 'none' })
      }
      const l = world.listeners()
      // At least B's daemon and its host replica (w-b's door) were seen listening: a sampler that saw nothing proves nothing.
      print({ name: `real: every port the run's processes on ${transport.label} listened on was on its loopback (at least B's daemon and w-b's door seen)`, ok: l.samples > 0 && l.seen >= 2 && l.open.length === 0, detail: `${l.samples} sample(s), ${l.seen} port(s)${l.open.length ? `; not on loopback: ${l.open.slice(0, 4).join('; ')}` : ''}` })
      if (host) console.log(`REAL  what this account wrote on ${transport.label} since the preflight, outside its Walnut dirs (evidence for a person to judge): ${path.join(evidence, 'written-since.txt')}`)
      const tf = world.tunnelFailures()
      print({ name: `real: every tunnel the run asked for opened`, ok: tf.length === 0, detail: tf.length ? tf.slice(0, 4).join(' | ') : 'all (tunnels.txt)' })
      const diff = (() => { try { return fs.readFileSync(path.join(evidence, 'procs-diff.txt'), 'utf8').trim() } catch { return 'no snapshot after' } })()
      print({ name: `real: ${transport.label}'s production processes are the same before and after the run`, ok: diff === '(the same)', detail: diff.split('\n').slice(0, 6).join(' | ') })
      if (confined) {
        // Every file (not a folder: a folder's time moves with what is made or removed in it) created or changed
        // since the marker, outside B's root and A's places (and /proc, /sys, /dev), each place by every name it has
        // here (this account's home is mounted as /home/<user> and /local/home/<user>). The places other sessions
        // write too (the repo's shared git dir, this task's folder, the account's real home) are listed apart, not counted.
        const aliases = (p: string): string[] => {
          const r = (() => { try { return fs.realpathSync(p) } catch { return p } })()
          return [...new Set([p, r].flatMap((x) => [x, x.startsWith('/local/home/') ? x.slice('/local'.length) : x.startsWith('/home/') ? `/local${x}` : x]))]
        }
        const skip = [...new Set(['/proc', '/sys', '/dev', bRoot, ...aPlaces].flatMap(aliases))]
        // The task folder the evidence is in (<task>/evidence/...): the task's other sessions write there.
        const taskDir = (() => {
          const e = flag('--real-evidence')
          const parts = e ? path.resolve(e).split('/') : []
          const i = parts.lastIndexOf('evidence')
          const d = i > 0 ? parts.slice(0, i).join('/') : ''
          return d.split('/').filter(Boolean).length >= 3 ? d : ''
        })()
        // The driver's own checkout too: B runs its staged copy, so a file there is A's or another session's.
        // The account's real home (from its user record: Bun's os.userInfo() follows $HOME, and no process of B has
        // it as HOME), which every dev container of this account shares (their npm logs, the Playwright cache).
        const accountHome = (() => { try { return execFileSync('getent', ['passwd', String(process.getuid?.() ?? '')], { encoding: 'utf8' }).split(':')[5]!.trim() } catch { return '' } })()
        const shared = [...new Set([repo, ...(accountHome ? [accountHome] : []), (() => { const d = git(['rev-parse', '--git-common-dir']); return d ? path.resolve(repo, d) : '' })(), taskDir].filter(Boolean).flatMap(aliases))]
        const prune = [...skip, ...shared].flatMap((p, i) => [...(i ? ['-o'] : []), '-path', p])
        const sharedPrune = skip.flatMap((p, i) => [...(i ? ['-o'] : []), '-path', p])
        const list = (roots: string[], pr: string[]) => {
          let out = ''
          try { out = execFileSync('find', [...roots, '(', ...pr, ')', '-prune', '-o', '!', '-type', 'd', '-newer', marker, '-print'], { encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'ignore'] }) } catch (err) { out = String((err as { stdout?: string }).stdout ?? '') }
          return out.split('\n').filter(Boolean)
        }
        if (childTimer) clearInterval(childTimer)
        // The machine-wide exit trace (/tmp/open-walnut-exit.log, server.ts exitTraceFile): A's when every line's
        // pid is a child of this driver (in (b) it is the dev container's own /tmp), else B's.
        const exitTrace = '/tmp/open-walnut-exit.log'
        const traceOf = (f: string) => f === exitTrace ? (() => { const pids = [...(fs.readFileSync(f, 'utf8').matchAll(/ pid=(\d+)/g))].map((m) => Number(m[1])); return { pids, mine: pids.length > 0 && pids.every((p) => aChildren.has(p)) } })() : null
        const ofA: string[] = []
        const found = list(['/'], prune).filter((f) => {
          const t = (() => { try { return traceOf(f) } catch { return null } })()
          if (!t?.mine) return true
          ofA.push(`${f}: pid(s) ${t.pids.map((p) => `${p} (${aChildren.get(p)})`).join(', ')}, each a child of this driver`)
          return false
        })
        for (const l of ofA) console.log(`OF-A  ${l}`)
        fs.writeFileSync(path.join(evidence, 'confined-of-a.txt'), `${ofA.join('\n')}\n`)
        const onShared = list(shared.filter((p) => fs.existsSync(p)), sharedPrune)
        // Who wrote it: each one's first and last lines (a small file), for the record.
        const heads = found.map((f) => {
          let body = ''
          try { const st = fs.statSync(f); body = st.isFile() && st.size <= 256 << 10 ? (() => { const l = fs.readFileSync(f, 'utf8').split('\n'); return [...l.slice(0, 5), ...(l.length > 10 ? ['...'] : []), ...l.slice(Math.max(5, l.length - 5))].join('\n') })() : `(${st.size} bytes)` } catch (err) { body = `(${err instanceof Error ? err.message : String(err)})` }
          return `== ${f}\n${body}`
        })
        fs.writeFileSync(path.join(evidence, 'confined-outside.txt'), `${found.join('\n')}\n${heads.length ? `\n${heads.join('\n')}\n` : ''}`)
        fs.writeFileSync(path.join(evidence, 'confined-shared.txt'), `${onShared.join('\n')}\n`)
        for (const f of found.slice(0, 50)) console.log(`OUTSIDE  ${f}`)
        for (const f of onShared.slice(0, 20)) console.log(`SHARED  ${f}`)
        print({ name: `real-fake: no file was written outside B's root (${bRoot}) and A's own places during the run`, ok: found.length === 0, detail: `${found.length} file(s) outside (left out: ${skip.join(', ')}); list in ${path.join(evidence, 'confined-outside.txt')}; ${onShared.length} on places other sessions write too (${shared.join(', ')}), in confined-shared.txt` })
      }
    },
  }
}

const main = !has('--kills') && !has('--stops') && !has('--trials') && !has('--flag-off') && !has('--restarts') && !has('--paths') && !has('--console')
if (main || all) {
  await rehearseLedgerControl(path.join(work, 'ledger-control'), print, ports())
  const r = await rehearseSwitchAndBack(path.join(work, 'main'), print, { ...ports(), fillerGb: gb, filler, noBack: has('--no-back'), log })
  console.log(`DOWNTIME  switch ${r.downtimeMs !== undefined ? (r.downtimeMs / 1000).toFixed(1) : '?'} s, back ${r.backDowntimeMs !== undefined ? (r.backDowntimeMs / 1000).toFixed(1) : '?'} s${gb ? ` (home with ${gb} GB filler, ${filler})` : ''}`)
}
if (main || all || has('--paths')) await rehearseHomePrefix(path.join(work, 'home-prefix'), print, ports())
if (has('--kills') || all) {
  for (const p of KILL_POINTS) await rehearseKill(path.join(work, `kill-${p}`), p, print, ports())
  await rehearseCancel(path.join(work, 'cancel'), print, ports())
  await rehearseCancelAfterCommit(path.join(work, 'cancel-after-commit'), print, ports())
}
if (has('--stops') || all) {
  await rehearseLateWriter(path.join(work, 'late-writer'), print, ports())
  await rehearseSignalInFinalBatch(path.join(work, 'signal-in-final-batch'), print, ports())
  await rehearseServerKilledInFinalBatch(path.join(work, 'server-killed-in-final-batch'), print, ports())
  await rehearseStopWait(path.join(work, 'stop-wait'), print, ports())
  await rehearseLauncherRace(path.join(work, 'launcher-race'), print, ports())
}
if (has('--trials') || all) for (const k of TRIAL_FAILURES) await rehearseTrialFailure(path.join(work, `trial-${k}`), k, print, ports())
if (has('--restarts') || all) {
  const r = await rehearseRestart(path.join(work, 'restarts'), print, ports())
  console.log(`DOORS CLOSED  planned restart ${r.plannedMs !== undefined ? (r.plannedMs / 1000).toFixed(1) : '?'} s, crash ${r.crashMs !== undefined ? (r.crashMs / 1000).toFixed(1) : '?'} s`)
}
if (has('--console') || all) {
  const awayAt = args.indexOf('--away-seconds')
  const dir = path.join(work, has('--as-installed') ? 'console-as-installed' : 'console')
  await rehearseConsole(dir, print, { ...ports(), asInstalled: has('--as-installed'), awaySeconds: awayAt >= 0 ? Number(args[awayAt + 1]) : 60, log, ...(await consoleExtras(dir)) })
}
if (has('--flag-off') || all) {
  await rehearseFlagOff(path.join(work, 'flag-off'), print, ports())
  await rehearseNoWitnesses(path.join(work, 'no-witnesses'), print, ports())
}
// The standby copies and the promoted homes are read-only on purpose (src/core/standby/), so a
// plain `rm -rf` of the work dir fails and leaves gigabytes behind: make the tree writable again,
// and drop it when every check passed (--keep keeps it); a failed run keeps it as evidence.
finish()

function finish(): never {
  makeWritable(work)
  if (!failed && !has('--keep')) fs.rmSync(work, { recursive: true, force: true })
  console.log(failed ? `${failed} check(s) FAILED; evidence in ${work} (writable, remove it with rm -rf)` : `all checks passed; ${has('--keep') ? `evidence in ${work}` : `work dir ${work} removed (--keep keeps it)`}`)
  process.exit(failed ? 1 : 0)
}

/**
 * `--browser`: a person's browser on A's console the whole time (console-browser.ts), recorded;
 * `--scale`: A's home at a real density first, and the worst load of `/` and of a session page,
 * five times each at the console and at the leader (console-scale.ts).
 */
async function consoleExtras(dir: string): Promise<Partial<Parameters<typeof rehearseConsole>[2]>> {
  if (!has('--browser') && !has('--scale')) return {}
  const { ConsoleBrowser, makeWalkData } = await import('./leader-switch/console-browser.js')
  const { SCALE, measureLoads, seedLargeHome } = await import('./leader-switch/console-scale.js')
  let b: InstanceType<typeof ConsoleBrowser> | null = null
  let data: Awaited<ReturnType<typeof makeWalkData>> | null = null
  let kept: string | null = null
  return {
    ...(has('--scale') ? { seedHome: (home: string, env: Record<string, string>) => seedLargeHome(home, env, dir) } : {}),
    online: async (cw, c) => {
      data = await makeWalkData(cw)
      if (has('--scale')) {
        for (const r of await measureLoads(cw, { id: data.board.id, answer: 'echo: hello from the leader' }, path.join(dir, 'loads'))) {
          console.log(`LOAD  ${r.where}, ${r.page}: worst ${r.worst} ms of ${r.ms.join(', ')} (home: ${SCALE.tasks} tasks, ${SCALE.sessions} sessions, ${SCALE.notes} notes)`)
          c.add(`load at scale: ${r.where}, ${r.page}, ${r.ms.length} of 5 loads`, !r.error && r.ms.length === 5, r.error ?? `worst ${r.worst} ms`)
        }
      }
      if (!has('--browser')) return
      b = new ConsoleBrowser(cw, path.join(dir, 'browser'), data)
      await b.open()
      await b.checkOnLeader(c, await b.walkOnline(c))
    },
    away: async (_cw, c) => { if (b) kept = (await b.walkAway(c)).keptTitle },
    back: async (_cw, c) => {
      if (!b) return
      await b.afterBack(c, kept)
      const errors = b.errors.filter((e) => !/ResizeObserver/.test(e))
      c.add('browser: no page error the whole time', errors.length === 0, errors.slice(0, 3).join(' | '))
      const video = await b.close()
      console.log(`VIDEO  ${video ?? 'none'}`)
    },
  }
}

function makeWritable(dir: string): void {
  try { fs.chmodSync(dir, fs.statSync(dir).mode | 0o700) } catch { return }
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) makeWritable(p)
    else if (e.isFile()) { try { fs.chmodSync(p, fs.statSync(p).mode | 0o600) } catch { /* gone */ } }
  }
}
