/**
 * walnut pass list|get|run: the vault for scripts and agents on this machine. The loop is
 * core/vault/pass-cli.ts, shared with the remote hosts' CLI (wn-cli.ts).
 */
import { executeOp } from '../ops/index.js'
import { LOCAL_ORIGIN } from '../lib/caller-origin.js'
import { PASS_EXIT, PASS_USAGE, parsePassArgv, runPass } from '../core/vault/pass-cli.js'
import { opFailure } from './approve.js'

export async function runPassCommand(argv: string[]): Promise<void> {
  const parsed = parsePassArgv(argv)
  if (!parsed.ok) {
    console.error(`walnut pass: ${parsed.error}\n${PASS_USAGE}`)
    process.exitCode = PASS_EXIT.error
    return
  }
  const { cliOpCaller } = await import('../lib/cli-sender.js')
  const caller = cliOpCaller()
  process.exitCode = await runPass(parsed, {
    call: async (name, args) => {
      const r = await executeOp(name, args, { origin: LOCAL_ORIGIN, ...caller })
      return r.ok ? { ok: true, result: r.result } : opFailure(r.message)
    },
    say: (line) => console.error(line),
    out: (text) => { process.stdout.write(text) },
    cwd: process.cwd(),
    onInterrupt: (fn) => {
      process.on('SIGINT', fn)
      process.on('SIGTERM', fn)
      return () => { process.off('SIGINT', fn); process.off('SIGTERM', fn) }
    },
  })
}
