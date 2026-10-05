/**
 * GET /api/diagnostics: the `open-walnut doctor` report.
 *
 *   GET /api/diagnostics                           → 200 JSON (DiagnosticsReport)
 *   GET /api/diagnostics?format=text               → 200 text/plain, paste-ready
 *   ...&section=hosts                              → the hosts section only (text or JSON)
 *   ...&redact=0                                   → keep usernames and hostnames
 *
 * Redacted by default: the text is made to be pasted into a public issue.
 * `redact=0` is honoured only for a caller on this Mac (request-origin.ts),
 * and never on a cloud replica: raw paths and hostnames are for the user's own
 * terminal, not for a paired phone, a LAN browser, a tunnel, or a loopback
 * self-call made for a remote host session. Secrets are masked in
 * every form (collectDiagnostics). Same auth posture as /api/bug-report: the
 * standard /api auth, NOT in CLOUD_EXEMPT_PATHS. Never 500s: the caller is
 * debugging. Concurrent requests share one collection (it runs a login shell
 * and `claude --version`), so a stuck client cannot fan out probes.
 */

import { Router, type Request, type Response } from 'express'
import { CLOUD_MODE } from '../../constants.js'
import { collectDiagnostics, type CollectOptions, type DiagnosticsReport } from '../../core/diagnostics/doctor.js'
import { hostsSection, redactDiagnostics, renderDiagnosticsText } from '../../core/diagnostics/render.js'
import { getWebAssetsReport } from './config.js'
import { log } from '../../logging/index.js'
import { requestOrigin } from '../middleware/request-origin.js'
import { isLocalOrigin } from '../../lib/caller-origin.js'

/**
 * The facts only the server knows: the terminal's dtach answer and the served
 * web app. A replica keeps the read-only dtach probe: it must never install or
 * compile anything on the cloud box from a diagnostics request.
 */
export function serverDiagnosticsOptions(cloudMode: boolean = CLOUD_MODE): CollectOptions {
  return {
    collector: 'server',
    probes: {
      ...(cloudMode ? {} : {
        dtach: async () => {
          // The terminal's own resolution (cached for the process once it succeeds).
          const { resolveLocalDtach, describeResolution } = await import('../terminal/dtach-provision.js')
          const r = await resolveLocalDtach()
          if (r.kind === 'ok') return { found: true, path: r.path, source: r.source }
          return { found: false, path: null, source: null, note: describeResolution(r) }
        },
      }),
      webAssets: async () => getWebAssetsReport()?.ok ?? null,
    },
  }
}

/**
 * Raw output only on a primary, for a request this machine trusts (local-trust.ts:
 * a loopback socket, no proxy header, its own Host and Origin) that also acts for
 * a caller on this Mac (request-origin.ts). The socket alone is not enough: a
 * tunnel arrives on loopback, and so does a self-call this server makes for a
 * remote host session or a paired client, which says so in x-walnut-origin.
 */
export function rawAllowed(req: Request, cloudMode: boolean = CLOUD_MODE): boolean {
  return !cloudMode && isLocalOrigin(requestOrigin(req))
}

function flag(value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback
  return !(value === '0' || value === 'false' || value === 'no')
}

export interface DiagnosticsRouterOptions {
  collect?: () => CollectOptions
  allowRaw?: (req: Request) => boolean
}

export function createDiagnosticsRouter(opts: DiagnosticsRouterOptions = {}): Router {
  const options = opts.collect ?? (() => serverDiagnosticsOptions())
  const allowRaw = opts.allowRaw ?? ((req: Request) => rawAllowed(req))
  const router = Router()
  let inFlight: Promise<DiagnosticsReport> | null = null

  router.get('/', async (req: Request, res: Response) => {
    const started = Date.now()
    const text = req.query.format === 'text'
    const askedRaw = !flag(req.query.redact, true)
    const redact = !askedRaw || !allowRaw(req)
    const section = req.query.section === 'hosts' ? 'hosts' : 'all'
    let report: DiagnosticsReport
    try {
      if (!inFlight) inFlight = collectDiagnostics(options()).finally(() => { inFlight = null })
      report = await inFlight
    } catch (err) {
      // collectDiagnostics never rejects by contract; still hand back something readable.
      const msg = err instanceof Error ? err.message : String(err)
      if (text) res.status(200).type('text/plain; charset=utf-8').send(`Open Walnut doctor\n(collection failed: ${msg})\n`)
      else res.status(200).json({ error: `collection failed: ${msg}` })
      return
    }
    const shown = redact ? redactDiagnostics(report) : report
    log.web.info('diagnostics generated', {
      ms: Date.now() - started, warnings: report.warnings.length, hosts: report.hosts.length,
      format: text ? 'text' : 'json', section, redact, rawRefused: askedRaw && redact, reqId: req.reqId,
    })
    if (askedRaw && redact) res.setHeader('X-Diagnostics-Redacted', 'forced')
    if (text) res.status(200).type('text/plain; charset=utf-8').send(`${renderDiagnosticsText(shown, { section })}\n`)
    else res.status(200).json(section === 'hosts' ? hostsSection(shown) : shown)
  })

  return router
}

export const diagnosticsRouter = createDiagnosticsRouter()
