/**
 * The on-disk list of work this daemon started the new way (a host_exec run or a plugin script
 * with `detach`, an ACP worker with `survive`): work that outlives the daemon and that a daemon of
 * this version adopts after a restart, but an older one does not know. Before a launcher puts an
 * older version back (a rollback), it ends what is listed here with the shell script below
 * (STOP_SCRIPT, installed as `<dir>/stop-detached.sh`), whatever state the new version is in (it may
 * have crashed): the launcher needs no Walnut code and no JSON reader for it.
 *
 * One file per run, `<dir>/<kind>-<id>.run`, `key=value` lines (values on one line):
 *   kind       host-exec | host-script | acp
 *   id         the run's id
 *   pid        the process that leads the run (the wrapper, or the ACP worker)
 *   pgid       its process group (what a stop signals)
 *   lstart     what `LC_ALL=C TZ=UTC ps -ww -o lstart= -p <pid>` said when it started: the stop signals
 *              only while the same process holds the pid (a pid used again later is left alone)
 *   note_file  a file a stop appends `note` to (the run's log), may be empty
 *   note       one line saying why it ended
 *   line_file  a file a stop appends `line` to (the host_exec audit, an ACP journal), may be empty
 *   line       one line written as is (JSON the older version reads)
 * A run's file is removed when its run ends (by the daemon that follows it), and by the stop script
 * once it handled it or found its process gone. Writes are whole (a temp file renamed) and async.
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'

export type DetachedKind = 'host-exec' | 'host-script' | 'acp'

export interface RegistryEntry {
  kind: DetachedKind
  id: string
  pid: number
  pgid: number
  lstart: string
  noteFile?: string
  note?: string
  lineFile?: string
  line?: string
}

const ID_RE = /^[A-Za-z0-9_.-]{1,128}$/

/**
 * What ps names as the start of `pid` (LC_ALL=C and TZ=UTC, so the stop script compares the same text
 * whatever the caller's time zone); null when it is gone or ps gave nothing (unknown, never "another process").
 */
export function processStart(pid: number): Promise<string | null> {
  return new Promise((resolve) => {
    if (!Number.isInteger(pid) || pid <= 1) return resolve(null)
    execFile('ps', ['-ww', '-o', 'lstart=', '-p', String(pid)], { timeout: 5_000, env: { PATH: '/bin:/usr/bin', LC_ALL: 'C', TZ: 'UTC' } }, (error, stdout) => {
      const out = String(stdout ?? '').trim()
      resolve(error || !out ? null : out)
    })
  })
}

const oneLine = (v: string | undefined): string => (v ?? '').replace(/[\r\n]+/g, ' ')

export function registryFile(dir: string, kind: DetachedKind, id: string): string {
  return path.join(dir, `${kind}-${id}.run`)
}

/** The file's text for an entry (tests read it too). */
export function registryText(e: RegistryEntry): string {
  return [
    `kind=${e.kind}`, `id=${e.id}`, `pid=${e.pid}`, `pgid=${e.pgid}`, `lstart=${oneLine(e.lstart)}`,
    `note_file=${oneLine(e.noteFile)}`, `note=${oneLine(e.note)}`, `line_file=${oneLine(e.lineFile)}`, `line=${oneLine(e.line)}`,
  ].join('\n') + '\n'
}

// Writes of one entry go one after another (the last one asked wins); each through its own temp file.
const chains = new Map<string, Promise<unknown>>()
let tmpSeq = 0
function inTurn<T>(file: string, work: () => Promise<T>): Promise<T> {
  const next = (chains.get(file) ?? Promise.resolve()).then(work, work)
  chains.set(file, next)
  void next.finally(() => { if (chains.get(file) === next) chains.delete(file) }).catch(() => {})
  return next
}

/** Lists a run (or writes its entry again, a changed `line`); never throws: a run with no entry still runs. */
export async function registerRun(dir: string, e: RegistryEntry): Promise<boolean> {
  if (!ID_RE.test(e.id) || !Number.isInteger(e.pid) || e.pid <= 1 || !Number.isInteger(e.pgid) || e.pgid <= 1) return false
  const file = registryFile(dir, e.kind, e.id)
  return inTurn(file, async () => {
    const tmp = `${file}.${process.pid}.${++tmpSeq}.t`
    try {
      await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 })
      await fs.promises.writeFile(tmp, registryText(e), { mode: 0o600 })
      await fs.promises.rename(tmp, file)
      return true
    } catch {
      try { await fs.promises.unlink(tmp) } catch { /* gone */ }
      return false
    }
  })
}

export async function unregisterRun(dir: string, kind: DetachedKind, id: string): Promise<void> {
  if (!ID_RE.test(id)) return
  const file = registryFile(dir, kind, id)
  await inTurn(file, async () => { try { await fs.promises.unlink(file) } catch { /* gone */ } })
}

/**
 * Ends every listed run whose process still is the one listed (same pid, same start): SIGTERM to
 * its group, up to 5 s for it to go, then SIGKILL; appends its note and line; removes its file.
 * Usage: stop-detached.sh <registry dir>. Prints one `stopped <kind> <id> <pid>` line per run it
 * ended and `gone <kind> <id>` for one whose process had already gone (or was another process).
 */
export const STOP_SCRIPT = `#!/bin/sh
# Ends the work a newer Walnut started that an older one cannot adopt (detached-registry.ts).
dir=$1
[ -n "$dir" ] && [ -d "$dir" ] || { echo "usage: $0 <registry dir>" >&2; exit 2; }
for f in "$dir"/*.run; do
  [ -f "$f" ] || continue
  kind= id= pid= pgid= lstart= note_file= note= line_file= line=
  while IFS= read -r kv || [ -n "$kv" ]; do
    case $kv in
      kind=*) kind=\${kv#kind=} ;;
      id=*) id=\${kv#id=} ;;
      pid=*) pid=\${kv#pid=} ;;
      pgid=*) pgid=\${kv#pgid=} ;;
      lstart=*) lstart=\${kv#lstart=} ;;
      note_file=*) note_file=\${kv#note_file=} ;;
      note=*) note=\${kv#note=} ;;
      line_file=*) line_file=\${kv#line_file=} ;;
      line=*) line=\${kv#line=} ;;
    esac
  done < "$f"
  case $pid in ''|*[!0-9]*) rm -f "$f"; continue ;; esac
  case $pgid in ''|*[!0-9]*) pgid=$pid ;; esac
  if [ "$pid" -le 1 ] || [ "$pgid" -le 1 ]; then rm -f "$f"; continue; fi
  now=$(LC_ALL=C TZ=UTC PATH=/bin:/usr/bin ps -ww -o lstart= -p "$pid" 2>/dev/null | sed 's/^ *//;s/ *$//')
  if [ -n "$now" ] && [ "$now" = "$lstart" ]; then
    kill -TERM -"$pgid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null
    i=0
    while kill -0 "$pid" 2>/dev/null && [ $i -lt 50 ]; do sleep 0.1; i=$((i+1)); done
    kill -KILL -"$pgid" 2>/dev/null
    [ -n "$note_file" ] && [ -n "$note" ] && printf '\\n%s\\n' "$note" >> "$note_file"
    [ -n "$line_file" ] && [ -n "$line" ] && printf '%s\\n' "$line" >> "$line_file"
    echo "stopped $kind $id $pid"
  else
    echo "gone $kind $id"
  fi
  rm -f "$f"
done
exit 0
`

/** Puts the stop script in the registry dir (`stop-detached.sh`), for a launcher; async, never throws. */
export async function installStopScript(dir: string): Promise<string | null> {
  const file = path.join(dir, 'stop-detached.sh')
  try {
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 })
    let same = false
    try { same = (await fs.promises.readFile(file, 'utf8')) === STOP_SCRIPT } catch { /* none yet */ }
    if (!same) {
      const tmp = `${file}.${process.pid}.t`
      await fs.promises.writeFile(tmp, STOP_SCRIPT, { mode: 0o700 })
      await fs.promises.rename(tmp, file)
    }
    return file
  } catch {
    return null
  }
}

/**
 * The detached work a daemon of this version adopts after a swap (its capabilities): the
 * successor names them in its service.update / service.handover (`adopts`), and the daemon it
 * replaces ends any kind the list leaves out (an older successor names none: a rollback).
 */
export const ADOPTED_WORK_CAPABILITIES = ['host-exec-detach-v1', 'host-script-detach-v1', 'acp-survive-v1'] as const

/** The note every rollback stop leaves, for each kind's own record. */
export const ROLLBACK_NOTE = 'Walnut on this host was put back to an older version (a rollback), which cannot follow this run, so it was stopped. Run it again if it is still needed.'
