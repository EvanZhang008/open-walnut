/**
 * What the cloud companion's copy does not keep goes to the Mac while it answers
 * (docs/plan/walnut-companion-unified-replica.md, 4f). The box's console routes for the
 * notes, memory and skills run here whoever answers (they read the copy), so a call about
 * what the copy leaves out (a kind turned off for the companion, a folder or a note left
 * out) is carried to the Mac's own route by the forward the phone's calls take
 * (web/v1-forward/proxy.ts consoleCopy; the paths: policy.ts CONSOLE_COPY_READS and
 * CONSOLE_COPY_WRITES). `here` answers on the box when the Mac does not take it: away,
 * too old, or a reply too large to carry.
 *
 * A phone call (`/api/v1/...`) reaches the box's route only after that forward chose to
 * answer here, so it is never asked again.
 */

import type { NextFunction, Request, Response } from 'express'

export function forwardUnkept(req: Request, res: Response, here: () => void): void {
  if (req.originalUrl === '/api/v1' || req.originalUrl.startsWith('/api/v1/')) { here(); return }
  void import('../web/v1-forward/proxy.js')
    .then((m) => m.getV1Forward().consoleCopy(req, res, here))
    .catch(() => { if (!res.headersSent) here() })
}

/**
 * Mounted on the companion's console routes: a read of a copy kind the user turned off for
 * the box (policy.ts consoleReadKindOf) is the Mac's while it answers; else the route runs
 * and answers needs-the-Mac (kinds/gate.ts assertCopyKept). A kept kind passes at once.
 */
export function companionUnkeptKindReads(req: Request, res: Response, next: NextFunction): void {
  if (req.method !== 'GET' && req.method !== 'HEAD') { next(); return }
  void (async () => {
    const { consoleReadKindOf } = await import('../web/v1-forward/policy.js')
    const kind = consoleReadKindOf(req.path)
    if (!kind) { next(); return }
    const { copyKindOff, keepsCopies } = await import('./replication/kinds/gate.js')
    if (!keepsCopies(kind) || !(await copyKindOff(kind))) { next(); return }
    forwardUnkept(req, res, () => next())
  })().catch(() => { if (!res.headersSent) next() })
}
