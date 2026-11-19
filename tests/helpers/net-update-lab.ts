/**
 * A small stand-in for a host's daemon and the fake daemon file it updates to, shared by
 * the host network update tests (daemon-net-update-io.test.ts, daemon-update-delta.test.ts).
 * fs.writePart is the daemons' own transfer core; exec.run runs the line with /bin/sh in a
 * process group of its own and, like the daemon, signals that whole group when the shell is
 * gone and something still holds its pipes 2 s later.
 *
 * MACHINE SAFETY: files only under the case's dirs and the /tmp/open-walnut-update.* dirs
 * the caller records in `made` and removes; the group signal goes only to a shell this
 * helper spawned (pid > 1 checked).
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { createTransferCore, type TransferCoreDeps } from '../../src/providers/transfer-core.js'
import type { NetUpdateConn } from '../../src/providers/daemon-net-update-io.js'
import { guardedPath } from '../setup/exec-guard.js'

export const LAB_VERSION = 'walnut-daemon-288f4bee1ea6'
export const LAB_STAGING = /\/tmp\/open-walnut-update\.[a-zA-Z0-9]+/

/** The fake daemon file: its version, and `walnut daemon update` refusing `refusals` times first. */
export function labDaemon(dirs: { work: string; state: string }, o: { refusals?: number; refusal?: string; supersede?: string; laterDir?: string; sleep?: number; version?: string; pad?: number; padText?: string; file?: string; onUpdate?: string[] } = {}): string {
  const { work, state } = dirs
  const file = path.join(work, o.file ?? 'daemon-src')
  const refusal = JSON.stringify({ ok: false, failure: { code: 'updateRefused', message: o.refusal ?? 'Daemon has active operations; retry after they finish' } })
  fs.writeFileSync(file, [
    '#!/bin/sh',
    `s='${state}'`,
    `if [ "$1 $2" = "__daemon --version" ]; then echo ${o.version ?? LAB_VERSION}; exit 0; fi`,
    'if [ "$1 $2 $3" = "walnut daemon update" ]; then',
    '  n=$(cat "$s/count" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$s/count"',
    '  echo "update pgid=$(ps -o pgid= -p $$ | tr -d " ") args=$*" >> "$s/calls"',
    // A later launch (another server's) names itself the latest while this one is refused.
    ...(o.supersede ? [`  [ "$n" -eq 1 ] && printf '%s\\n' '${o.laterDir ?? '/tmp/open-walnut-update.Later1'}' > '${o.supersede}'`] : []),
    ...(o.sleep ? [`  sleep ${o.sleep}`] : []),
    ...(o.onUpdate ?? []).map((line) => `  ${line}`),
    `  if [ "$n" -le ${o.refusals ?? 0} ]; then printf '%s\\n' '${refusal}'; exit 1; fi`,
    `  printf '%s\\n' '{"ok":true,"status":{"scope":"user"}}'; exit 0`,
    'fi',
    'exit 2',
    // Bytes that do not compress, so the gz spans several chunks.
    ...(o.pad ? [`# ${crypto.randomBytes(o.pad).toString('base64')}`] : []),
    // Bytes a case chooses (a delta case changes some of them, keeping every offset).
    ...(o.padText ? [`# ${o.padText}`] : []),
    '',
  ].join('\n'), { mode: 0o755 })
  return file
}

export interface Host extends NetUpdateConn { lines: string[]; writes: string[]; jobGroups: number[] }

/**
 * The daemon's side of the three commands; `corrupt(path)` damages a write in transit.
 * HOME is the case's own empty home, so the runner's tail finds no service config unless a case puts one there.
 */
export function labHost(dirs: { work: string; home: string; made: Set<string> }, o: { path?: string; corrupt?: (p: string) => boolean; readFails?: () => boolean; signalGroup?: 'always' | 'drain'; noise?: string; beforeRun?: (line: string) => void } = {}): Host {
  const { work, home, made } = dirs
  const env = { ...process.env, HOME: home, PATH: o.path ?? guardedPath() }
  const core = createTransferCore({ fs, path, crypto, spawn: spawn as unknown as TransferCoreDeps['spawn'], env, home: work })
  const host: Host = {
    lines: [], writes: [], jobGroups: [],
    async send(cmd, params = {}) {
      if (cmd === 'fs.writePart') {
        const p = String(params.path)
        host.writes.push(p)
        let data = String(params.data)
        if (o.corrupt?.(p)) { const b = Buffer.from(data, 'base64'); b[0] ^= 0xff; data = b.toString('base64') }
        try { return { ok: true, ...(await core.writePart({ ...params, data })) } } catch (e) { return { ok: false, error: (e as Error).message, code: (e as { code?: string }).code } }
      }
      if (cmd === 'fs.read') {
        if (o.readFails?.()) throw new Error('DaemonConnection not connected to studio-mac')
        try { return { ok: true, data: fs.readFileSync(String(params.path), 'utf8') } } catch (e) { return { ok: false, error: (e as Error).message } }
      }
      if (cmd === 'exec.run') {
        const argv = params.argv as string[] | undefined
        const line = argv ? argv[2] : String(params.command)
        host.lines.push(line)
        o.beforeRun?.(line)
        const child = argv ? spawn(argv[0], argv.slice(1), { env, cwd: '/', detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
          : spawn('/bin/sh', ['-c', line], { env, cwd: '/', detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
        // What a login profile prints lands in the same output, before the line runs.
        let output = o.noise ?? ''
        child.stdout!.on('data', (d) => { output += d })
        child.stderr!.on('data', (d) => { output += d })
        const signal = () => {
          if (typeof child.pid === 'number' && child.pid > 1) {
            host.jobGroups.push(child.pid)
            try { process.kill(-child.pid, 'SIGTERM') } catch { /* the group is gone */ }
          }
        }
        // Like the daemon (host-exec-core.ts EXIT_DRAIN_MS): pipes still held 2 s after the
        // shell exited get the group signalled and closed.
        let closed = false
        child.on('exit', () => { setTimeout(() => { if (!closed) { signal(); child.stdout!.destroy(); child.stderr!.destroy() } }, 2_000).unref() })
        const exitCode = await new Promise<number | null>((r) => child.on('close', (code) => { closed = true; r(code ?? child.exitCode) }))
        if (o.signalGroup === 'always') signal()
        for (const m of output.matchAll(new RegExp(LAB_STAGING.source, 'g'))) made.add(m[0])
        return { ok: true, exitCode, output, timedOut: false, killed: false, blocked: null }
      }
      return { ok: false, error: `unknown command: ${cmd}` }
    },
  }
  return host
}

