/**
 * `GET /api/v1/offline-conflicts/:drainId`: one host drain's conflict log in full
 * (src/core/offline-merge/conflict-log.ts), the target of every "Full entry" link in
 * the conflict letter. Read only, behind the same device auth as the rest of /api/v1.
 */

import { Router, type Request, type Response } from 'express';
import { readConflictLog } from '../../core/offline-merge/conflict-log.js';

export const offlineConflictsV1Router = Router();

const DRAIN_ID_RE = /^d-[A-Za-z0-9_-]{1,120}$/;

offlineConflictsV1Router.get('/offline-conflicts/:drainId', (req: Request, res: Response) => {
  const drainId = String(req.params.drainId ?? '');
  if (!DRAIN_ID_RE.test(drainId)) {
    res.status(400).json({ error: { code: 'bad_request', message: 'not a drain id' } });
    return;
  }
  const file = readConflictLog(drainId);
  if (!file) {
    res.status(404).json({ error: { code: 'not_found', message: 'no conflict log with that id' } });
    return;
  }
  res.json({ drainId: file.drainId, host: file.hostKey, startedAt: file.startedAt, entries: file.entries, letter: file.letter ?? null });
});
