/**
 * Run by tests/providers/in-process-stop-reap.test.ts with bun: an in-process runtime on an isolated
 * dir with N live fake CLIs that take 1.5 s to exit after SIGINT (as the real CLI's cleanup and
 * SessionEnd hooks do). stopInProcessDaemon must wait for them (their exit, never cut short) without
 * holding this process's event loop (the reap's waits are timers: A3b, 2026-11-21). Prints one JSON
 * line: the stop's wall time, the longest lateness of a 5 ms interval while it ran, the CLIs left.
 * MACHINE SAFETY: a temp root only; only the runtime signals, and only the groups it started.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const DIR = process.env.WALNUT_DAEMON_DIR!
const ROOT = process.env.REAP_ROOT!
const N = 3
const { startInProcessDaemon, stopInProcessDaemon, IN_PROCESS_DAEMON_URL } = await import('../../../src/providers/in-process-daemon.ts')
const { RemoteSessionManager } = await import('../../../src/providers/remote-session-manager.ts')
const { disconnectAllDaemons } = await import('../../../src/providers/daemon-connection.ts')

const cli = path.join(ROOT, 'fake-cli.sh')
fs.writeFileSync(cli, `#!/bin/sh
sid=fake
while [ $# -gt 0 ]; do
  if [ "$1" = "--session-id" ]; then sid="$2"; fi
  shift
done
echo "{\\"type\\":\\"system\\",\\"subtype\\":\\"init\\",\\"session_id\\":\\"$sid\\",\\"model\\":\\"fake\\",\\"tools\\":[]}"
bg=
on_int() { kill $bg 2>/dev/null; sleep 1.5; exit 0; }
trap on_int INT
while :; do sleep 1 & bg=$!; wait $bg; done
`, { mode: 0o755 })
const work = path.join(ROOT, 'work')
fs.mkdirSync(work, { recursive: true })

const alive = (pid: number) => {
  try { const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); const st = s.slice(s.lastIndexOf(')') + 2)[0]; return st !== 'Z' && st !== 'X' } catch { return false }
}

await startInProcessDaemon({ dir: DIR, env: { ...process.env } })
const pids: number[] = []
for (let i = 0; i < N; i++) {
  const sid = crypto.randomUUID()
  const rsm = new RemoteSessionManager(sid, '__local__', null, IN_PROCESS_DAEMON_URL, cli)
  const r = await rsm.start({ args: ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--session-id', sid], cwd: work, message: 'go', mode: 'bypass', onOutput: () => {}, onExit: () => {} })
  pids.push(r.pid)
  await rsm.cleanup()
}
disconnectAllDaemons()
await new Promise((r) => setTimeout(r, 500))

let last = performance.now()
let maxLate = 0
const tick = setInterval(() => { const now = performance.now(); maxLate = Math.max(maxLate, now - last - 5); last = now }, 5)
const a = performance.now()
const code = await stopInProcessDaemon('test')
const stopMs = Math.round(performance.now() - a)
await new Promise((r) => setTimeout(r, 30))
clearInterval(tick)
console.log(JSON.stringify({ code, stopMs, maxLateMs: Math.round(maxLate), started: pids.length, aliveAfter: pids.filter(alive).length }))
