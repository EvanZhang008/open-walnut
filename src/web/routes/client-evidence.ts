/**
 * Client-side divergence evidence — the browser half of the incident loop.
 *
 * WHY THIS EXISTS (inc-1786165723472 forensics gap): the render-filter tripwire
 * ("N completed blocks had no delta twin") used to ship its evidence through the
 * browser-console log forwarder, which truncates args at 1000 chars — a
 * 200-entry flight trace survived as ~12 entries and 78 unmatched blocks as 5.
 * The incident bundle therefore could not answer "what did the client actually
 * consume", which is the whole point of the recorder.
 *
 * This route receives the UNTRUNCATED payload:
 *   POST /api/client-evidence { sessionId, kind, flightTrace, unmatched,
 *                               blocksSummary, messagesSummary }
 * and:
 *   1. writes it verbatim to LOG_DIR/client-evidence/<sessionId>-<ts>.json
 *      (same ephemeral home as the logs; never enters version control);
 *   2. opens a durable incident (trigger 'client', deduped per sid+kind within
 *      the store's window) so divergences surface on the bell and in
 *      /api/incidents WITHOUT anyone grepping — the user's "emit issue data
 *      points we can query later" requirement. The incident's bundle capture
 *      then freezes server logs alongside, and captureBundle picks the evidence
 *      file up as client-evidence.json.
 *
 * Shapes only, no content: the client sends ids/lengths/reasons (flight
 * recorder discipline), so the file is safe to keep and cheap to store.
 */

import { Router, type Request, type Response } from 'express'
import fs from 'node:fs'
import path from 'node:path'
import { LOG_DIR } from '../../constants.js'
import { log } from '../../logging/index.js'

export const CLIENT_EVIDENCE_DIR = path.join(LOG_DIR, 'client-evidence')

/** Keep the most recent N evidence files per session (storms are deduped at the
 *  incident layer, but the raw files are per-fire — cap them). */
const MAX_FILES_PER_SESSION = 5
/** Hard cap on a single payload (shapes only — 2 MB is already generous). */
const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024

export interface ClientEvidencePayload {
  sessionId: string
  /** Detector id, e.g. 'render-filter-no-twin'. Becomes the incident label. */
  kind: string
  /** Human summary for the incident row. */
  summary?: string
  /** Full flight-recorder ring (ids/shapes only). */
  flightTrace?: unknown[]
  /** Full unmatched-block diagnostics from computeRenderFilter. */
  unmatched?: unknown[]
  /** Compact snapshots of client state (ids/kinds/lengths, no content). */
  blocksSummary?: unknown[]
  messagesSummary?: unknown[]
}

function isValid(p: unknown): p is ClientEvidencePayload {
  if (!p || typeof p !== 'object') return false
  const o = p as Record<string, unknown>
  return typeof o.sessionId === 'string' && o.sessionId.length > 0
    && typeof o.kind === 'string' && o.kind.length > 0 && o.kind.length < 100
}

/** Prune old evidence files for a session, newest kept. Best-effort. */
function pruneSession(sessionId: string): void {
  try {
    const files = fs.readdirSync(CLIENT_EVIDENCE_DIR)
      .filter(f => f.startsWith(`${sessionId}-`) && f.endsWith('.json'))
      .sort() // ts suffix → lexicographic = chronological
    for (const f of files.slice(0, Math.max(0, files.length - MAX_FILES_PER_SESSION))) {
      fs.unlinkSync(path.join(CLIENT_EVIDENCE_DIR, f))
    }
  } catch { /* prune is best-effort */ }
}

export const clientEvidenceRouter = Router()

clientEvidenceRouter.post('/', async (req: Request, res: Response) => {
  try {
    const payload = req.body as unknown
    if (!isValid(payload)) {
      res.status(400).json({ error: 'sessionId and kind are required' })
      return
    }
    const raw = JSON.stringify(payload)
    if (raw.length > MAX_PAYLOAD_BYTES) {
      res.status(413).json({ error: 'payload too large' })
      return
    }

    // 1. Persist verbatim — the forensic artifact.
    fs.mkdirSync(CLIENT_EVIDENCE_DIR, { recursive: true })
    const file = path.join(CLIENT_EVIDENCE_DIR, `${payload.sessionId}-${Date.now()}.json`)
    fs.writeFileSync(file, raw)
    pruneSession(payload.sessionId)

    // 2. Open a durable incident (deduped per sid+kind). Failure here must not
    //    fail the evidence write — the file is already on disk.
    let incidentId: string | undefined
    try {
      const { createIncidentIfNotRecent } = await import('../../core/observability/incidents.js')
      const incident = await createIncidentIfNotRecent({
        sessionId: payload.sessionId,
        trigger: 'client',
        label: payload.kind,
        summary: payload.summary
          ?? `client divergence: ${payload.kind} (${(payload.unmatched?.length ?? 0)} unmatched, trace ${(payload.flightTrace?.length ?? 0)} entries)`,
        severity: 'warn',
        bundlePath: file,
      })
      incidentId = incident?.id
    } catch (err) {
      log.obs.warn('client-evidence: incident open failed (evidence file kept)', {
        sessionId: payload.sessionId, error: err instanceof Error ? err.message : String(err),
      })
    }

    log.obs.info('client evidence captured', {
      sessionId: payload.sessionId, kind: payload.kind, file,
      traceEntries: payload.flightTrace?.length ?? 0,
      unmatched: payload.unmatched?.length ?? 0,
      incidentId,
    })
    res.json({ ok: true, file, incidentId })
  } catch (err) {
    log.obs.warn('client-evidence route error', { error: err instanceof Error ? err.message : String(err) })
    res.status(500).json({ error: 'internal' })
  }
})

/** Latest evidence file for a session WITH its real upload time, or null.
 *  Used by the bundle capturer. The upload time is parsed from the
 *  `<sessionId>-<ts>.json` filename this route itself writes — callers MUST
 *  surface it: inc-1786496042099 was mis-diagnosed as a client-array
 *  regression because the bundle attached a 7.5-minute-old evidence file
 *  under a meta.json whose capturedAt was the BUNDLE's clock, so the payload
 *  read as a snapshot of the wrong instant. */
export function latestClientEvidence(
  sessionId: string,
): { content: string; uploadedAtMs: number } | null {
  try {
    const files = fs.readdirSync(CLIENT_EVIDENCE_DIR)
      .filter(f => f.startsWith(`${sessionId}-`) && f.endsWith('.json'))
      .sort()
    const last = files[files.length - 1]
    if (!last) return null
    const tsRaw = last.slice(sessionId.length + 1, -'.json'.length)
    const uploadedAtMs = Number(tsRaw)
    return {
      content: fs.readFileSync(path.join(CLIENT_EVIDENCE_DIR, last), 'utf-8'),
      uploadedAtMs: Number.isFinite(uploadedAtMs) ? uploadedAtMs : 0,
    }
  } catch {
    return null
  }
}
