/**
 * `GET /api/v1/offline-conflicts/:drainId`: one host drain's conflict log in full
 * (src/core/offline-merge/conflict-log.ts), the target of every "Full entry" link in
 * the conflict letter. Read only, behind the same device auth as the rest of /api/v1.
 *
 * The logs are the Mac's: its drains write them, and no copy of them goes anywhere.
 * A follower (the companion, a host replica) answers this route only while the Mac
 * does not, and then needs the Mac, never the files git sync once brought to the box
 * (stage 4d of docs/plan/walnut-companion-unified-replica.md: those stop).
 *
 * An entry about a locked or hidden note (`why`) keeps the words typed away (`replica`, `base`):
 * only the person reads them here (person-caller.ts isPersonInOwnWindow); an agent, a script or a
 * forwarded call gets the entry without them (docs/reference/locked-notes.md).
 */

import { Router, type NextFunction, type Request, type Response } from 'express';
import { readConflictLog } from '../../core/offline-merge/conflict-log.js';
import { NeedsLeaderError } from '../../core/replication/needs-leader.js';
import { isFollower } from '../../core/server-role.js';
import { isPersonInOwnWindow } from './person-caller.js';

export const offlineConflictsV1Router = Router();

const DRAIN_ID_RE = /^d-[A-Za-z0-9_-]{1,120}$/;

offlineConflictsV1Router.get('/offline-conflicts/:drainId', (req: Request, res: Response, next: NextFunction) => {
  const drainId = String(req.params.drainId ?? '');
  if (!DRAIN_ID_RE.test(drainId)) {
    res.status(400).json({ error: { code: 'bad_request', message: 'not a drain id' } });
    return;
  }
  if (isFollower()) {
    next(new NeedsLeaderError('conflict_log_needs_mac'));
    return;
  }
  const file = readConflictLog(drainId);
  if (!file) {
    res.status(404).json({ error: { code: 'not_found', message: 'no conflict log with that id' } });
    return;
  }
  const person = isPersonInOwnWindow(req);
  const entries = person ? file.entries : file.entries.map((e) => {
    if (e.why !== 'locked' && e.why !== 'hidden') return e;
    const { replica: _replica, base: _base, ...rest } = e;
    return { ...rest, withheld: 'The words typed away are shown only to you, in Walnut on the Mac.' };
  });
  res.json({ drainId: file.drainId, host: file.hostKey, startedAt: file.startedAt, entries, letter: file.letter ?? null });
});
