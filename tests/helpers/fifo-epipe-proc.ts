/**
 * An adopting daemon's write to a surviving ACP worker that died (src/providers/acp-survive.ts): the
 * pipe's write end is O_WRONLY, so a write with no reader left gets EPIPE, and SIGPIPE too unless the
 * runtime ignores it. This process opens the channel as an adopter does, its reader ends, it writes,
 * and it prints `{"survived":true,"error":"EPIPE"}` when the write failed and the process lives on.
 * Run with bun, node, or as a `bun build --compile` binary (the daemon's own runtime).
 *
 * Usage: <runtime> fifo-epipe-proc.ts <empty dir>
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { openSurviveChannel, survivePaths } from '../../src/providers/acp-survive.js'

const dir = process.argv[2]
if (!dir) { console.error('usage: fifo-epipe-proc <dir>'); process.exit(2) }
const p = survivePaths(dir, 'sid-epipe')
if (spawnSync('mkfifo', ['-m', '600', p.fifo]).status !== 0) { console.error('mkfifo failed'); process.exit(2) }
fs.writeFileSync(p.out, '')
// The worker's stand-in: holds the read end, and exits when told.
const reader = spawn('/bin/sh', ['-c', 'exec 3<"$1"; read -r _ <&3; exit 0', 'sh', p.fifo], { stdio: 'ignore' })
const opened = async (): Promise<number> => {
  for (let i = 0; i < 400; i++) {
    try { return fs.openSync(p.fifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK) } catch { await new Promise((r) => setTimeout(r, 10)) }
  }
  throw new Error('the reader never opened the pipe')
}
const fd = await opened()
const channel = openSurviveChannel(p, { from: 0, adopted: false, fd, onLine: () => {}, log: () => {} })
// The reader reads one line and exits: the worker died.
await new Promise<void>((resolve) => { channel.write('bye\n'); reader.once('exit', () => resolve()) })
const error = await new Promise<string | null>((resolve) => channel.write('after the worker died\n', (err) => resolve(err ? ((err as NodeJS.ErrnoException).code ?? err.message) : null)))
process.stdout.write(JSON.stringify({ survived: true, error }) + '\n')
try { channel.close() } catch { /* closed */ }
fs.rmSync(path.join(dir), { recursive: true, force: true })
process.exit(0)
