/**
 * A take uploaded in parts while it records, so the server hears its finished
 * part ahead and the stop waits only for the tail (src/core/stt/take-ahead.ts).
 *
 * POST   /api/stt/takes/:takeId/append?offset=<bytes on the server>&format=<webm|mp4|...>&language=<hint>
 *        body: the next bytes of the recorder's clip (application/octet-stream)
 *        200 { size } | 409 { error, size } (send from `size`) | 404 (unknown: a restart lost it; the client
 *        sends it again from 0) | 503 (busy; tried again) | 400/410/413 (stop for this take).
 *        The client's action per answer: APPEND_ANSWER in web/src/api/stt-take-ahead.ts
 * DELETE /api/stt/takes/:takeId   a take that will not be finished (a discarded recording)
 *
 * The stop itself is POST /api/stt/transcribe with `take=<takeId>` (stt.ts).
 */

import express, { Router, type Request, type Response, type NextFunction } from 'express';
import { getConfig } from '../../core/config-manager.js';
import { appendToTake, dropTake, hearWavIn, TAKE_ID } from '../../core/stt/take-ahead.js';
import { ALLOWED_FORMATS } from './stt.js';

export const sttTakesRouter = Router();

/** One part: the client sends about 15 s at a time, far under this. */
const APPEND_LIMIT = '50mb';

sttTakesRouter.post('/takes/:takeId/append', express.raw({ type: 'application/octet-stream', limit: APPEND_LIMIT }), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.takeId);
    const format = typeof req.query.format === 'string' ? req.query.format : '';
    const offset = Number(req.query.offset);
    if (!TAKE_ID.test(id) || !ALLOWED_FORMATS.has(format) || !Number.isSafeInteger(offset) || offset < 0) {
      res.status(400).json({ error: 'Invalid take id, format or offset' });
      return;
    }
    const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const language = (typeof req.query.language === 'string' && req.query.language) || (await getConfig()).stt?.language;
    const out = await appendToTake(id, offset, bytes, { format, language, hear: hearWavIn(language) });
    if (out.ok) res.json({ size: out.size });
    else res.status(out.status).json({ error: out.error, ...(out.size !== undefined ? { size: out.size } : {}) });
  } catch (err) {
    next(err);
  }
});

sttTakesRouter.delete('/takes/:takeId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ dropped: await dropTake(String(req.params.takeId)) });
  } catch (err) {
    next(err);
  }
});
