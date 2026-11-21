/**
 * A host-exec core in a process of its own, as a daemon runs it: a test kills it (SIGKILL, as a
 * crash or a forced end does) and starts the next one on the same state dir, to prove that a
 * detached run outlives the daemon that started it (src/providers/detached-run.ts).
 *
 * Usage: bun host-exec-core-proc.ts <stateDir> <taskDirRoot> <home>. One JSON request per stdin
 * line, `{id, op, req}` with op run | read | kill | list | script; one JSON answer per line,
 * `{id, ok, value}` or `{id, ok: false, error, code}`. It prints `{ready: true, pid}` first.
 * HOST_EXEC_PROC_NO_PS=1: ps never answers here (a daemon that dies before it learned a run's start).
 */
import { spawn } from 'node:child_process'
import readline from 'node:readline'
import { createHostExec } from '../../src/providers/host-exec-core.js'

const [stateDir, taskDirRoot, home] = process.argv.slice(2)
const core = createHostExec({
  spawn, killGroup: (pid, signal) => { if (pid > 1) process.kill(-pid, signal) },
  shell: '/bin/sh', home: home!, taskDirRoot: taskDirRoot!, stateDir: stateDir!,
  env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home! }, promptProbe: null,
  ...(process.env.HOST_EXEC_PROC_NO_PS === '1' ? { processStart: async () => null } : {}),
})
const write = (o: unknown) => process.stdout.write(JSON.stringify(o) + '\n')
const ops: Record<string, (req: never) => Promise<unknown>> = {
  run: core.run as never, read: core.read as never, kill: core.kill as never, list: core.list as never, script: core.script as never,
  counts: (async () => ({ running: core.running(), holding: core.holding(), detached: core.detachedRunning(), scripts: core.scripts(), detachedScripts: core.detachedScripts() })) as never,
}
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let msg: { id: number; op: string; req: unknown }
  try { msg = JSON.parse(line) } catch { return }
  const op = ops[msg.op]
  if (!op) return write({ id: msg.id, ok: false, error: `unknown op ${msg.op}` })
  op(msg.req as never).then(
    (value) => write({ id: msg.id, ok: true, value }),
    (err: Error & { code?: string }) => write({ id: msg.id, ok: false, error: err.message, code: err.code }),
  )
})
write({ ready: true, pid: process.pid })
