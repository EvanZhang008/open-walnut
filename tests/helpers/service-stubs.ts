/**
 * Stand-ins for the init systems a daemon update's tail talks to (src/providers/daemon-update-tail.ts),
 * so it runs for real in /bin/sh without touching the machine's own: `uname` (says Darwin or
 * Linux), `launchctl` (print/bootout/bootstrap/kickstart of one job, which may be loaded and idle, in a domain that may start
 * no jobs at all or refuse to load it, plus the spawn probe's throwaway jobs, one per label, and
 * `list`) and `systemctl --user` (is-active,
 * start, restart of one unit). A load whose config names an executable with "good" in its path
 * starts a "daemon": a `sleep` whose pid and a port file land in the runtime dir; one with "bad"
 * starts nothing (it never answers); one with "flaky" too answers, and exits a second later (a
 * build that listens and then dies); one with "crash" is started and exits at once, so launchd's
 * job is idle again (and `runs` counts it, as launchd's print does). Every call is logged in `calls`.
 *
 * As the real ones do (2026-11-04 review: the stubs assumed "never two at once" instead of
 * testing it): launchd starts a job it loaded and left pending once it starts jobs again
 * (setSpawning(true)); and the job's daemon honours the instance lock: while another daemon
 * serves the runtime dir it exits (logged in `lock-refusals`), except behind a stand-in
 * (daemon.standin names the holder), which it waits out and then serves, as a --service
 * daemon does. A bootout stops the job's own process, never a stand-in; with setBootoutLinger it
 * returns at once while that process finishes for a few seconds more, and the job is listed (and
 * loads no other) till it is gone, as launchd does up to the job's ExitTimeOut.
 *
 * MACHINE SAFETY: the stubs only touch their state dir and the runtime dir they are given (and
 * the spawn probe's own /tmp/walnut-spawn-probe.<id> dir, which the probe makes and removes); the
 * only processes are `sleep`s they start, and `stop()` signals only those (pid > 1 checked) and
 * the stand-in loop of their runtime dir (checked by its command line).
 * PATH puts the stubs first, then the exec guard, then /usr/bin:/bin.
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { guardedPath } from '../setup/exec-guard.js'

export interface ServiceStubs {
  bin: string
  state: string
  runtime: string
  env: Record<string, string>
  calls(): string[]
  /** Start the "daemon" now, as if the service ran this executable. */
  startDaemon(executable: string): void
  daemonUp(): boolean
  /**
   * The job (launchd) or the unit (systemd) is loaded or active. `idle`: nothing runs, the job
   * loaded and idle (launchd) or the unit waiting out a crash (systemd: activating, auto-restart).
   */
  setLoaded(on: boolean, config?: string, idle?: boolean): void
  /** launchd starts jobs (true: a job loaded and left pending starts now), or loads them and starts none, as in a dark wake (false). */
  setSpawning(on: boolean): void
  /** The pid of every daemon a job start found serving the dir (not a stand-in), so it exited. */
  lockRefusals(): string[]
  /** launchd refuses to load the service's job at all (true). */
  setBootstrapFails(on: boolean): void
  /** The user turned the job off (`launchctl disable`): print-disabled says so, and a bootstrap is refused. */
  setDisabled(on: boolean): void
  /** The spawn probe's job runs this many seconds after its load (null: at once). */
  setProbeDelay(seconds: number | null): void
  /** A bootout of the service's job returns at once, and its process (and listing) goes this many seconds later (null: at once). */
  setBootoutLinger(seconds: number | null): void
  /** Labels the stub `launchctl list` prints besides the probes it loaded (a stale probe of a dead run). */
  setListed(labels: string[]): void
  /** The probe labels loaded so far, in order. */
  probes(): string[]
  /** Stops the stand-in loop of the runtime dir (daemon-update-standin.ts), then every daemon the stubs started. */
  stop(): void
}

export function createServiceStubs(dir: string, os: 'Darwin' | 'Linux'): ServiceStubs {
  const bin = path.join(dir, 'stub-bin')
  const state = path.join(dir, 'stub-state')
  const runtime = path.join(dir, 'runtime')
  for (const d of [bin, state, runtime]) fs.mkdirSync(d, { recursive: true })
  const write = (name: string, lines: string[]) => fs.writeFileSync(path.join(bin, name), ['#!/bin/sh', ...lines, ''].join('\n'), { mode: 0o755 })
  const start = path.join(state, 'start-daemon')
  fs.writeFileSync(start, [
    '#!/bin/sh',
    // A build that crashes at once: launchd ran it, and its job is idle again.
    `case "$1" in *crash*) : > '${state}/idle'; exit 0;; esac`,
    'case "$1" in *good*) ;; *) exit 0;; esac',
    'case "$1" in *flaky*) life=1;; *) life=300;; esac',
    `rt='${runtime}'; st='${state}'`,
    'h=$(cat "$rt/daemon.pid" 2>/dev/null)',
    'if [ -n "$h" ] && kill -0 "$h" 2>/dev/null; then',
    '  [ "$(cat "$rt/daemon.standin" 2>/dev/null)" = "$h" ] || { echo "$h" >> "$st/lock-refusals"; exit 0; }',
    // Behind a stand-in: wait for it to go, then take the dir.
    `  sh -c 'while kill -0 "$1" 2>/dev/null; do sleep 0.2; done; echo $$ > "$2/daemon.pid"; echo 40999 > "$2/daemon.port"; exec sleep 300' sh "$h" "$rt" </dev/null >/dev/null 2>&1 &`,
    'else',
    '  sleep "$life" </dev/null >/dev/null 2>&1 &',
    '  echo $! > "$rt/daemon.pid"; echo 40999 > "$rt/daemon.port"',
    'fi',
    'echo $! >> "$st/pids"; echo $! > "$st/jobpid"',
    '',
  ].join('\n'), { mode: 0o755 })
  // The job's own process: its pid and port go with it only when it is the one serving.
  const stopDaemon = `jp=$(cat '${state}/jobpid' 2>/dev/null); rm -f '${state}/jobpid'; if [ -n "$jp" ]; then kill "$jp" 2>/dev/null; [ "$(cat '${runtime}/daemon.pid' 2>/dev/null)" = "$jp" ] && rm -f '${runtime}/daemon.pid' '${runtime}/daemon.port'; fi; :`
  write('uname', [`echo ${os}`])
  write('launchctl', [
    `st='${state}'`,
    'echo "launchctl $*" >> "$st/calls"',
    // The spawn probe's own throwaway job (daemon-update-tail.ts t_spawns): one job per label (a second
    // load of a loaded label fails, as launchd's does); launchd runs its touch unless it starts no jobs,
    // after `probe-delay` s when that file holds a number.
    'case "$*" in *spawn-probe*)',
    '  case "$1" in',
    `    bootstrap) pl=$(sed -n 's/.*<key>Label<\\/key><string>\\([^<]*\\)<\\/string>.*/\\1/p' "$3")`,
    '      { [ -f "$st/probe.$pl" ] || [ -f "$st/probe-fails" ]; } && { echo "Bootstrap failed: 5: Input/output error" >&2; exit 5; }',
    '      echo "$3" > "$st/probe.$pl"; echo "$pl" >> "$st/probes"',
    '      [ -f "$st/no-spawn" ] && exit 0',
    '      pd=$(cat "$st/probe-delay" 2>/dev/null); ran="$(dirname "$3")/ran"',
    '      if [ -n "$pd" ]; then (sleep "$pd"; [ -d "$(dirname "$ran")" ] && : > "$ran") </dev/null >/dev/null 2>&1 & else : > "$ran"; fi; exit 0;;',
    '    bootout) pl=${2##*/}; [ -f "$st/probe.$pl" ] || exit 3; rm -f "$st/probe.$pl"; exit 0;;',
    '  esac; exit 0;;',
    'esac',
    'case "$1" in',
    // The labels of loaded jobs, as `launchctl list` prints them (PID, status, label).
    '  list) for f in "$st"/probe.*; do [ -f "$f" ] && printf "%s\\t0\\t%s\\n" - "${f##*/probe.}"; done; cat "$st/list" 2>/dev/null; exit 0;;',
    // As launchd prints it: one line per label it has an override for.
    `  print-disabled) printf 'disabled services = {\\n\\t"com.apple.mediaanalysisd" => enabled\\n'; [ -f "$st/disabled" ] && printf '\\t"dev.openwalnut.session-daemon" => disabled\\n'; printf '}\\n'; exit 0;;`,
    // As launchd prints it: the state, the plist, how many times it ran the job since its load, and its pid while it runs.
    '  print) if [ -f "$st/job" ]; then if [ -f "$st/idle" ]; then echo "state = not running"; else echo "state = running"; fi; echo "path = $(cat "$st/job")"',
    '    echo "runs = $(cat "$st/runs" 2>/dev/null || echo 0)"; [ -f "$st/idle" ] || { jp=$(cat "$st/jobpid" 2>/dev/null); [ -n "$jp" ] && echo "pid = $jp"; }; exit 0; fi; echo "Could not find service" >&2; exit 113;;',
    `  bootout) if [ -f "$st/job" ]; then lg=$(cat "$st/bootout-linger" 2>/dev/null)`,
    // Lingering: the job stays listed, and its process serves, till it finished its work.
    `    if [ -n "$lg" ] && [ ! -f "$st/lingering" ]; then : > "$st/lingering"; (sleep "$lg"; rm -f "$st/job" "$st/idle" "$st/lingering"; ${stopDaemon}) </dev/null >/dev/null 2>&1 & exit 0; fi`,
    `    [ -f "$st/lingering" ] && exit 0; rm -f "$st/job" "$st/idle"; ${stopDaemon}; exit 0; fi; exit 3;;`,
    '  bootstrap) [ -f "$st/job" ] && exit 5',
    // A job launchd will not load at all (a plist it rejects, a domain that refuses it).
    '    [ -f "$st/bootstrap-fails" ] && { echo "Bootstrap failed: 5: Input/output error" >&2; exit 5; }',
    '    [ -f "$st/disabled" ] && { echo "Bootstrap failed: 119: Service is disabled" >&2; exit 119; }',
    '    echo "$3" > "$st/job"; plist="$3"; echo 0 > "$st/runs"',
    // A domain in on-demand-only mode (a dark wake): the job is loaded, and nothing is started.
    '    [ -f "$st/no-spawn" ] && { : > "$st/idle"; exit 0; }',
    '    ;;',
    '  kickstart) [ -f "$st/job" ] || exit 113; [ -f "$st/idle" ] || exit 0; [ -f "$st/no-spawn" ] && exit 0; rm -f "$st/idle"; plist=$(cat "$st/job");;',
    '  *) exit 1;;',
    'esac',
    // A load or a kickstart runs the plist's executable (one run more).
    `exe=$(sed -n '/<key>ProgramArguments<\\/key>/{n;n;s/^[[:space:]]*<string>\\(.*\\)<\\/string>.*$/\\1/p;}' "$plist")`,
    'echo $(( $(cat "$st/runs" 2>/dev/null || echo 0) + 1 )) > "$st/runs"',
    `'${start}' "$exe"; exit 0`,
  ])
  write('systemctl', [
    `st='${state}'`,
    'echo "systemctl $*" >> "$st/calls"',
    '[ "$1" = --user ] && shift',
    'case "$1" in',
    // `idle` for a unit: waiting out a crash (activating, SubState auto-restart), nothing running.
    '  is-active) if [ -f "$st/job" ]; then if [ -f "$st/idle" ]; then echo activating; exit 3; fi; echo active; exit 0; fi; echo inactive; exit 3;;',
    // As systemd 219 (long-lived distributions) answers: no --value, and SubState=<word>.
    '  show) case " $* " in *" --value "*) echo "systemctl: unrecognized option \'--value\'" >&2; exit 1;; esac',
    '    if [ -f "$st/idle" ]; then echo SubState=auto-restart; else echo SubState=running; fi; exit 0;;',
    '  daemon-reload|reset-failed) exit 0;;',
    `  start|restart) unit="$HOME/.config/systemd/user/$2"; [ "$1" = restart ] && { ${stopDaemon}; }`,
    '    [ "$1" = start ] && [ -f "$st/job" ] && [ ! -f "$st/idle" ] && exit 0; rm -f "$st/idle"',
    '    echo "$unit" > "$st/job"',
    `    exe=$(sed -n 's/^ExecStart="\\([^"]*\\)".*/\\1/p' "$unit"); '${start}' "$exe"; exit 0;;`,
    'esac',
    'exit 1',
  ])
  return {
    bin, state, runtime,
    // Nothing of this machine's PATH but the base tools; the exec guard still comes before them.
    env: { PATH: guardedPath([bin], '/usr/bin:/bin') },
    calls: () => (fs.existsSync(path.join(state, 'calls')) ? fs.readFileSync(path.join(state, 'calls'), 'utf8').trim().split('\n') : []),
    startDaemon(executable) {
      const out = spawnSync('/bin/sh', [start, executable], { stdio: 'ignore' })
      if (out.status !== 0) throw new Error('the stub daemon did not start')
    },
    daemonUp() {
      const pid = Number(fs.existsSync(path.join(runtime, 'daemon.pid')) ? fs.readFileSync(path.join(runtime, 'daemon.pid'), 'utf8').trim() : 0)
      try { return pid > 1 && process.kill(pid, 0) } catch { return false }
    },
    setLoaded(on, config = '', idle = false) {
      if (on) fs.writeFileSync(path.join(state, 'job'), `${config}\n`)
      else fs.rmSync(path.join(state, 'job'), { force: true })
      if (on && idle) fs.writeFileSync(path.join(state, 'idle'), '')
      else fs.rmSync(path.join(state, 'idle'), { force: true })
    },
    setSpawning(on) {
      if (!on) { fs.writeFileSync(path.join(state, 'no-spawn'), ''); return }
      fs.rmSync(path.join(state, 'no-spawn'), { force: true })
      // launchd starts the job it loaded and left pending, now that it starts jobs.
      const job = path.join(state, 'job'), idle = path.join(state, 'idle')
      if (os !== 'Darwin' || !fs.existsSync(job) || !fs.existsSync(idle)) return
      fs.rmSync(idle)
      const plist = fs.readFileSync(job, 'utf8').trim()
      const exe = /<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]*)<\/string>/.exec(fs.existsSync(plist) ? fs.readFileSync(plist, 'utf8') : '')?.[1]
      if (!exe) return
      const runs = path.join(state, 'runs')
      fs.writeFileSync(runs, `${Number(fs.existsSync(runs) ? fs.readFileSync(runs, 'utf8').trim() : 0) + 1}\n`)
      spawnSync('/bin/sh', [start, exe], { stdio: 'ignore' })
    },
    lockRefusals: () => (fs.existsSync(path.join(state, 'lock-refusals')) ? fs.readFileSync(path.join(state, 'lock-refusals'), 'utf8').trim().split('\n') : []),
    setBootstrapFails(on) {
      if (on) fs.writeFileSync(path.join(state, 'bootstrap-fails'), '')
      else fs.rmSync(path.join(state, 'bootstrap-fails'), { force: true })
    },
    setDisabled(on) {
      if (on) fs.writeFileSync(path.join(state, 'disabled'), '')
      else fs.rmSync(path.join(state, 'disabled'), { force: true })
    },
    setProbeDelay(seconds) {
      if (seconds === null) fs.rmSync(path.join(state, 'probe-delay'), { force: true })
      else fs.writeFileSync(path.join(state, 'probe-delay'), String(seconds))
    },
    setBootoutLinger(seconds) {
      if (seconds === null) fs.rmSync(path.join(state, 'bootout-linger'), { force: true })
      else fs.writeFileSync(path.join(state, 'bootout-linger'), String(seconds))
    },
    setListed(labels) {
      fs.writeFileSync(path.join(state, 'list'), labels.map((l) => `-\t0\t${l}\n`).join(''))
    },
    probes: () => (fs.existsSync(path.join(state, 'probes')) ? fs.readFileSync(path.join(state, 'probes'), 'utf8').trim().split('\n') : []),
    stop() {
      // The stand-in loop first, or it starts the daemon stopped below again. Only a pid of a sh
      // running the stand-in script of this runtime dir (its first argument) is signalled.
      const loopPid = Number(fs.existsSync(path.join(runtime, '.standin-loop', 'pid')) ? fs.readFileSync(path.join(runtime, '.standin-loop', 'pid'), 'utf8').trim() : 0)
      if (Number.isSafeInteger(loopPid) && loopPid > 1) {
        const cmd = spawnSync('ps', ['-o', 'args=', '-p', String(loopPid)], { encoding: 'utf8' }).stdout ?? ''
        if (cmd.includes('daemon-standin.sh') && cmd.includes(runtime)) try { process.kill(loopPid, 'SIGTERM') } catch { /* gone */ }
      }
      const file = path.join(state, 'pids')
      const pids = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map(Number) : []
      for (const pid of pids) if (Number.isSafeInteger(pid) && pid > 1) try { process.kill(pid, 'SIGTERM') } catch { /* gone */ }
    },
  }
}
