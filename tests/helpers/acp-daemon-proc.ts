/**
 * An ACP daemon (src/providers/acp-daemon.ts) in a process of its own, so a test can kill it
 * (SIGKILL, as a crash or a forced end does) while its workers run, and start the next one on
 * the same dirs (tests/providers/acp-survive.test.ts).
 *
 * Usage: bun acp-daemon-proc.ts <streamsDir> <daemonDir>. One JSON request per stdin line,
 * `{id, op: 'start' | 'op' | 'holding', ...}`; one JSON answer per line, `{id, value}`. Prints
 * `{ready: true, pid}` first.
 */
import readline from 'node:readline'
import { createAcpDaemon } from '../../src/providers/acp-daemon.js'

const [streamsDir, daemonDir] = process.argv.slice(2)
const ws = { open: true }
const acp = createAcpDaemon<typeof ws>({
  streamsDir: streamsDir!, daemonDir: daemonDir!,
  sendEvent: () => {}, isWsOpen: () => true, log: () => {}, strictStop: () => true,
})
const write = (o: unknown) => process.stdout.write(JSON.stringify(o) + '\n')
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line) as { id: number; op: string; params?: Record<string, unknown>; sid?: string; workerOp?: string }
  const run = async (): Promise<unknown> => {
    if (m.op === 'start') return acp.acpStart(ws, m.params as never)
    if (m.op === 'op') return acp.acpOp(m.sid!, m.workerOp!, m.params)
    if (m.op === 'holding') return { holding: acp.holdingWorkers(), workers: acp.workers.size }
    throw new Error(`unknown op ${m.op}`)
  }
  run().then((value) => write({ id: m.id, value }), (err: Error) => write({ id: m.id, error: err.message }))
})
write({ ready: true, pid: process.pid })
