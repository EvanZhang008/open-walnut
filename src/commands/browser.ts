/**
 * walnut browser <action>: the person's browser for scripts and agents on this machine. The
 * loop is core/browser-control/browser-cli.ts, shared with the remote hosts' CLI (wn-cli.ts).
 */
import { executeOp } from '../ops/index.js'
import { LOCAL_ORIGIN } from '../lib/caller-origin.js'
import { BROWSER_EXIT, BROWSER_USAGE, parseBrowserArgv, runBrowser } from '../core/browser-control/browser-cli.js'
import { opFailure } from './approve.js'

export async function runBrowserCommand(argv: string[]): Promise<void> {
  const parsed = parseBrowserArgv(argv)
  if (!parsed.ok) {
    console.error(`walnut browser: ${parsed.error}\n${BROWSER_USAGE}`)
    process.exitCode = BROWSER_EXIT.error
    return
  }
  const { cliAutomationSender } = await import('../lib/cli-sender.js')
  const sender = cliAutomationSender()
  process.exitCode = await runBrowser(parsed, {
    call: async (name, args) => {
      const r = await executeOp(name, args, { origin: LOCAL_ORIGIN, ...(sender ? { sender } : {}) })
      return r.ok ? { ok: true, result: r.result } : opFailure(r.message)
    },
    say: (line) => console.error(line),
    out: (text) => { process.stdout.write(text) },
    cwd: process.cwd(),
    env: process.env,
  })
}
