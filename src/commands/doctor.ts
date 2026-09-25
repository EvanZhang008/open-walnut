/**
 * `open-walnut doctor` (also `walnut doctor`): print the paste-ready report of
 * which build, claude, node and PATH this machine runs and what every host can
 * run. Asks the running server first, because only the server knows its hosts;
 * with no server up it collects this machine's half itself and says so.
 *
 * stdout carries exactly the report (so `walnut doctor | pbcopy` copies it);
 * notes about how it was collected go to stderr. Exit code 0 whatever the
 * report says: a doctor that finds problems has done its job. It writes
 * nothing: config.yaml is read as it is (never restored from its backup), and
 * any probe child still running when the report is printed is ended.
 */

import { apiBaseUrl } from '../utils/api-client.js'
import type { GlobalOptions } from '../core/types.js'
import type { DiagnosticsReport } from '../core/diagnostics/types.js'

export interface DoctorOptions {
  /** false = keep usernames and hostnames (commander's `--no-redact`). */
  redact?: boolean
  /** Only the hosts block. */
  hosts?: boolean
}

/** Collection runs several bounded probes plus a `hello` per host: well under this. */
const SERVER_TIMEOUT_MS = 30_000

type ServerAnswer = { ok: true; body: string } | { ok: false; why: string }

async function askServer(base: string, query: URLSearchParams): Promise<ServerAnswer> {
  let res: Response
  try {
    res = await fetch(`${base}/api/diagnostics?${query}`, { signal: AbortSignal.timeout(SERVER_TIMEOUT_MS) })
  } catch (err) {
    const name = (err as { name?: string } | undefined)?.name
    return { ok: false, why: name === 'TimeoutError' || name === 'AbortError' ? `no answer within ${SERVER_TIMEOUT_MS / 1000}s` : 'not running' }
  }
  if (res.status === 404) return { ok: false, why: 'running an older build without /api/diagnostics' }
  if (!res.ok) return { ok: false, why: `answered HTTP ${res.status}` }
  return { ok: true, body: await res.text() }
}

export async function runDoctor(options: DoctorOptions, globals: GlobalOptions): Promise<void> {
  const redact = options.redact !== false
  const base = apiBaseUrl()
  const query = new URLSearchParams({ format: globals.json ? 'json' : 'text', redact: redact ? '1' : '0' })
  if (options.hosts) query.set('section', 'hosts')

  const answer = await askServer(base, query)
  if (answer.ok) {
    process.stdout.write(answer.body.endsWith('\n') ? answer.body : `${answer.body}\n`)
    return
  }

  console.error(`The Open Walnut server at ${base} is ${answer.why}; this report covers this machine only.`)
  const { collectDiagnostics } = await import('../core/diagnostics/doctor.js')
  const { hostsSection, redactDiagnostics, renderDiagnosticsText } = await import('../core/diagnostics/render.js')
  const { killLeftoverProbes } = await import('../core/diagnostics/local-probes.js')
  try {
    const collected: DiagnosticsReport = await collectDiagnostics({ collector: 'cli' })
    const report = redact ? redactDiagnostics(collected) : collected
    if (globals.json) {
      process.stdout.write(`${JSON.stringify(options.hosts ? hostsSection(report) : report, null, 2)}\n`)
      return
    }
    process.stdout.write(`${renderDiagnosticsText(report, { section: options.hosts ? 'hosts' : 'all' })}\n`)
  } finally {
    // A probe a deadline gave up on (a slow rc file, a hung claude) must not hold the CLI open.
    killLeftoverProbes()
  }
}
