/**
 * The RemoteDaemonUpdateIo (daemon-service-update.ts) for a host reached over the
 * host network, where there is no SSH: every step is a command of the very daemon
 * the update replaces.
 *
 *   run           exec.run (host-exec-v1): the line as `/bin/sh -c <line>` argv, so the
 *                 login shell (zsh on a Mac) never parses it; a line over an older
 *                 daemon's 8 KB argv word goes as a command. The bytes never ride a
 *                 command line (2026-11-03: a 2 MB argv was refused with E2BIG). The
 *                 login shell runs the user's profile first, and whatever that prints
 *                 shares the output, so the line prints a marker of its own first and
 *                 only what follows it is the answer.
 *   chunk         fs.writePart (fs-write-part-v1): one file per chunk, its size and
 *                 sha256 checked by the host before the file appears.
 *   serviceUpdate the final `walnut daemon update` runs from a script (written with
 *                 fs.writePart) started DETACHED: out of the exec job's process group,
 *                 which the daemon signals when the job ends, and off its pipes,
 *                 because the old daemon exits during the handover and must not take
 *                 the update with it. The script retries while the old daemon answers
 *                 "has active operations" (the very exec.run that started it is one
 *                 such operation); after that refusal the update has put the old
 *                 service config back and the running daemon keeps serving. A script
 *                 a later update replaced stops before its next try, so a server of an
 *                 older build never puts its build back over a newer one. Its result
 *                 is read back with fs.read, from the new daemon once the link is back.
 *
 * Every host the network reaches has these commands: net-v1 (2026-11-01) came after
 * fs-write-part-v1 and host-facts-v1 (2026-10-21) and host-exec-v1 (2026-10-31), so
 * no older fallback is kept.
 */
import { createHash, randomBytes } from 'node:crypto'
import type { RemoteDaemonUpdateIo } from './daemon-service-update.js'

export interface NetUpdateConn {
  send(cmd: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>
}

export interface NetUpdateIoOptions {
  /** How many times the script runs `walnut daemon update` while the old daemon says it is busy. */
  tries?: number
  /** Seconds between those attempts. */
  pauseSeconds?: number
  /** Seconds the script waits before its first attempt, so the exec.run that started it is over. */
  settleSeconds?: number
  /** How often, and how long at most, the server reads for the script's result. */
  pollMs?: number
  waitMs?: number
  /** Asked right before the detached start: a reason holds the update (nothing changed yet). */
  beforeLaunch?: () => string | null
  /** How long a hold met there is waited out, the upload already on the host, before giving up. */
  holdWaitMs?: number
  /** The file naming the latest update's staging dir (tests point it elsewhere). */
  latestMarker?: string
  /** True once nobody waits for the answer any more (the connection was closed for good). */
  cancelled?: () => boolean
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

export const RUNNER_TRIES = 30
export const RUNNER_PAUSE_SECONDS = 10
const POLL_MS = 5_000
const WAIT_MS = 15 * 60_000
/** An older daemon's longest argv word (host-exec-line.ts ARG_MAX_CHARS). */
const ARGV_WORD_MAX = 8 * 1024
/** exec.run's own cap on a foreground run (host-exec-core.ts FOREGROUND_MAX_MS). */
const FOREGROUND_MAX_MS = 10 * 60_000
const STAGING = /^\/tmp\/open-walnut-update\.[a-zA-Z0-9]+$/
const HOLD_WAIT_MS = 2 * 60_000
export const LAUNCHED = 'walnut-update-started'
/** One per user: a hyphen, so it never matches STAGING. */
const LATEST_MARKER = '"/tmp/open-walnut-update-latest-$(id -u)"'
const SUPERSEDED = 'rc=superseded'

/** The update was held before anything changed on the host (a write in flight): ask again later. */
export class NetUpdateHeldError extends Error {}

/** Quote one word for a POSIX shell. */
export function shq(s: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`
}

const markerWord = (latest?: string) => (latest ? shq(latest) : LATEST_MARKER)

/**
 * The detached script: it writes its pid, waits for the launcher's go (written only once
 * the launcher saw it run in a process group of its own), then runs `command` until it
 * succeeds, fails for another reason, or `tries` busy refusals. Before each try it stops
 * when the latest marker (a file of this user's) names another update's dir: a later
 * launch took over. It removes the uploaded executable (the service keeps its own copy)
 * and writes `update.done` last.
 */
export function runnerScript(o: { directory: string; command: string; executable: string; tries?: number; pauseSeconds?: number; settleSeconds?: number; latest?: string }): string {
  const d = shq(o.directory)
  const ownExe = o.executable.startsWith(`${o.directory}/`)
  return [
    '#!/bin/sh',
    '# Walnut daemon update runner (src/providers/daemon-net-update-io.ts), started detached.',
    `d=${d}`,
    `L=${markerWord(o.latest)}`,
    'echo $$ > "$d/update.pid"',
    'k=0',
    // No go (the launcher found it in the job's group, or its dir was removed) or none within 10 s: it changes nothing.
    'while [ ! -e "$d/update.go" ]; do k=$((k+1)); [ -e "$d/update.nogo" ] || [ ! -d "$d" ] || [ "$k" -gt 100 ] && exit 0; sleep 0.1; done',
    `sleep ${o.settleSeconds ?? 2}`,
    'n=0; rc=0',
    'while :; do',
    '  [ -d "$d" ] || exit 0',
    // Only a marker this user owns counts: another user's file in /tmp proves nothing.
    `  if [ -f "$L" ] && [ -O "$L" ] && [ "$(cat "$L" 2>/dev/null)" != "$d" ]; then rc=superseded; break; fi`,
    '  n=$((n+1))',
    `  ${o.command} >"$d/update.out" 2>"$d/update.err"`,
    '  rc=$?',
    '  [ "$rc" -eq 0 ] && break',
    `  [ "$n" -ge ${o.tries ?? RUNNER_TRIES} ] && break`,
    // Only the busy refusal is asked again: after it the old service config is back (daemon-service-manager.ts).
    `  grep -q '"updateRefused"' "$d/update.out" 2>/dev/null || break`,
    `  grep -Eq 'has active operations|must finish first' "$d/update.out" 2>/dev/null || break`,
    `  sleep ${o.pauseSeconds ?? RUNNER_PAUSE_SECONDS}`,
    'done',
    ...(ownExe ? [`rm -f ${shq(o.executable)}`] : []),
    `printf 'rc=%s tries=%s\\n' "$rc" "$n" > "$d/update.done.tmp" && mv -f "$d/update.done.tmp" "$d/update.done"`,
    '',
  ].join('\n')
}

/**
 * Start the script out of this job's process group: setsid (Linux), else perl's setsid
 * (every Mac has perl; its python3 may be the stub that asks to install developer tools),
 * else bash job control (dash refuses `set -m` without a terminal), else sh's. Then prove
 * it: the script's process group must differ from ours, else it is told no go (it exits
 * before it changed anything; nothing is signalled) and the line fails.
 */
export function launcherScript(directory: string, latest?: string): string {
  const d = shq(directory)
  return [
    `d=${d}; s="$d/update.sh"; L=${markerWord(latest)}`,
    'if command -v setsid >/dev/null 2>&1; then setsid /bin/sh "$s" </dev/null >/dev/null 2>&1 &',
    "elif command -v perl >/dev/null 2>&1; then perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV' /bin/sh \"$s\" </dev/null >/dev/null 2>&1 &",
    `elif command -v bash >/dev/null 2>&1; then bash -c 'set -m; /bin/sh "$1" </dev/null >/dev/null 2>&1 &' sh "$s" 2>/dev/null`,
    'else (set -m; /bin/sh "$s" </dev/null >/dev/null 2>&1 &) 2>/dev/null',
    'fi',
    'k=0; while [ ! -s "$d/update.pid" ] && [ "$k" -lt 50 ]; do k=$((k+1)); sleep 0.1; done',
    'r=$(cat "$d/update.pid" 2>/dev/null); case "$r" in ""|*[!0-9]*) r="";; esac',
    'g=""; [ -n "$r" ] && g=$(ps -o pgid= -p "$r" 2>/dev/null | tr -d " ")',
    'm=$(ps -o pgid= -p $$ 2>/dev/null | tr -d " ")',
    // The marker is written in the private dir and renamed into place, never through a name in /tmp.
    `if [ -n "$r" ] && [ -n "$g" ] && [ -n "$m" ] && [ "$g" != "$m" ]; then printf '%s\\n' "$d" > "$d/latest.tmp" && mv -f "$d/latest.tmp" "$L" 2>/dev/null; : > "$d/update.go"; echo "${LAUNCHED} pid=$r group=$g own=$m"`,
    'else : > "$d/update.nogo"; echo "walnut-update-not-detached pid=$r group=$g own=$m"; exit 1; fi',
  ].join('\n')
}

function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

export function createNetUpdateIo(conn: NetUpdateConn, opts: NetUpdateIoOptions = {}): RemoteDaemonUpdateIo {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => { const t = setTimeout(r, ms); t.unref?.() }))
  const now = opts.now ?? Date.now

  async function run(command: string, timeoutMs = 30_000): Promise<string> {
    const limit = Math.min(Math.max(timeoutMs, 1_000), FOREGROUND_MAX_MS)
    const mark = `walnut-update-output-${randomBytes(4).toString('hex')}`
    const line = `printf '%s\\n' ${mark}; ${command}`
    const shape = line.length <= ARGV_WORD_MAX ? { argv: ['/bin/sh', '-c', line] } : { command: line }
    const reply = await conn.send('exec.run', {
      jobId: `hx-walnut-update-${randomBytes(6).toString('hex')}`, ...shape, cwd: '/', timeoutMs: limit,
      caller: { task: 'walnut-daemon-update' },
    }, limit + 15_000)
    if (reply.ok !== true) throw new Error(`the host did not run the command: ${String(reply.error ?? reply.code ?? 'no answer')}`)
    const raw = typeof reply.output === 'string' ? reply.output : ''
    const at = raw.indexOf(`${mark}\n`)
    const output = at < 0 ? raw : raw.slice(at + mark.length + 1)
    if (reply.exitCode !== 0 || reply.timedOut === true || reply.killed === true || reply.blocked) {
      const end = reply.timedOut === true ? 'its deadline' : reply.blocked ? 'a dialog' : `exit ${String(reply.exitCode ?? reply.signal)}`
      throw new Error(`the command on the host stopped at ${end}: ${output.trim().slice(-500)}`)
    }
    return output.trim()
  }

  async function writeFile(path: string, data: Buffer): Promise<boolean> {
    const sum = sha256(data)
    try {
      const reply = await conn.send('fs.writePart', { path, offset: 0, data: data.toString('base64'), final: true, size: data.length, sha256: sum }, 60_000)
      return reply.ok === true && reply.done === true && reply.sha256 === sum
    } catch {
      return false
    }
  }

  async function readText(path: string): Promise<string | null> {
    try {
      const reply = await conn.send('fs.read', { path, encoding: 'utf8' }, 15_000)
      return reply.ok === true && typeof reply.data === 'string' ? reply.data : null
    } catch {
      return null
    }
  }

  return {
    run,
    chunk: (data, directory, index) => writeFile(`${directory}/chunk_${String(index).padStart(4, '0')}`, data),
    async serviceUpdate({ command, directory, executable }) {
      if (!directory || !STAGING.test(directory)) throw new Error('the update runs from a staging dir of its own')
      const script = runnerScript({ directory, command, executable, tries: opts.tries, pauseSeconds: opts.pauseSeconds, settleSeconds: opts.settleSeconds, latest: opts.latestMarker })
      if (!(await writeFile(`${directory}/update.sh`, Buffer.from(script)))) throw new Error('the update script could not be put on the host')
      // The upload is on the host: a short hold (a file write, a dropped link) is waited out, not paid for with another upload.
      const holdWait = opts.holdWaitMs ?? HOLD_WAIT_MS
      const holdUntil = now() + holdWait
      let held = opts.beforeLaunch?.() ?? null
      while (held && now() < holdUntil && !opts.cancelled?.()) {
        await sleep(Math.min(2_000, Math.max(50, holdWait / 4)))
        held = opts.beforeLaunch?.() ?? null
      }
      if (held) throw new NetUpdateHeldError(held)
      const said = await run(launcherScript(directory, opts.latestMarker), 30_000).catch((err: Error) => `${err.message}`)
      if (!said.includes(LAUNCHED)) throw new Error(`the update did not start detached from the daemon: ${said.slice(-300)}`)
      // The old daemon exits during the handover: reads fail until the link is back on the new one.
      const deadline = now() + (opts.waitMs ?? WAIT_MS)
      while (now() < deadline) {
        await sleep(opts.pollMs ?? POLL_MS)
        if (opts.cancelled?.()) throw new Error('nobody waits for the update any more; it may still finish on the host')
        const done = await readText(`${directory}/update.done`)
        if (done === null) continue
        if (done.includes(SUPERSEDED)) throw new Error('a later update on the host took over before this one ran')
        const out = (await readText(`${directory}/update.out`)) ?? ''
        const at = out.indexOf('{')
        if (at < 0) throw new Error(`the update gave no answer Walnut could read (${done.trim()}): ${out.trim().slice(-300)}`)
        return out.slice(at)
      }
      throw new Error(`the update on the host did not report back within ${Math.round((opts.waitMs ?? WAIT_MS) / 1000)} s; it may still finish there`)
    },
  }
}
