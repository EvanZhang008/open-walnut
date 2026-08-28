/**
 * Agent task search route — GET /api/search/agent?q=...
 *
 * A one-shot claude -p child (haiku) iterates search queries through the
 * walnut CLI and answers with task ids; the core layer validates ids against
 * the real task table and enriches from it. See core/task-search-agent.ts.
 *
 * Error contract the web client depends on (mirrors sessions.ts AI summary):
 *   503 + {code:'ai_disabled'}  → the ONLY code the client latches PERMANENTLY
 *                                 (also returned when the claude CLI is absent,
 *                                 and always on test servers via
 *                                 backgroundAiDisabled() — a hidden panel on a
 *                                 test server is correct, not broken)
 *   400                         → hide, no retry (bad query)
 *   429 {code:'busy'} / 502 {code:'agent_failed'|'unparseable'} /
 *   504 {code:'timeout'}        → "unavailable · Retry"
 *
 * GET (not POST) because the web client's apiPost carries no AbortSignal and
 * abort-on-query-change is required. Cache-Control: no-store guards the
 * client's GET-only 304 retry path.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';

/** Route deadline: the engine's own timeout is 50s; this outer race answers
 *  the HTTP request either way (the child keeps running to completion and a
 *  retry joins the still-warm cache / in-flight entry). Env override exists
 *  for tests — a 60s wait is untestable wall-clock. */
function routeDeadlineMs(): number {
  const fromEnv = Number(process.env.WALNUT_AGENT_SEARCH_DEADLINE_MS);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 60_000;
}

export const searchAgentRouter = Router();

searchAgentRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const q = String(req.query.q ?? '').trim();
    if (q.length < 4) {
      res.status(400).json({ error: 'q must be at least 4 characters' });
      return;
    }
    if (q.length > 400) {
      res.status(400).json({ error: 'q must be at most 400 characters' });
      return;
    }
    res.setHeader('Cache-Control', 'no-store');

    // Optional progress id: the panel subscribes to 'search-agent:progress'
    // WS events carrying this id and renders live mini-session lines.
    const rawSid = req.query.sid;
    const sid = typeof rawSid === 'string' && /^[A-Za-z0-9_-]{6,64}$/.test(rawSid) ? rawSid : undefined;

    const { runTaskSearchAgent, AgentSearchError } = await import('../../core/task-search-agent.js');
    const timeout = new Promise<never>((_, reject) => {
      deadline = setTimeout(
        () => reject(new AgentSearchError('AI search timed out', 504, { code: 'timeout' })),
        routeDeadlineMs(),
      );
    });
    res.json(await Promise.race([runTaskSearchAgent(q, sid ? { progressId: sid } : {}), timeout]));
  } catch (err) {
    const { AgentSearchError } = await import('../../core/task-search-agent.js');
    if (err instanceof AgentSearchError) {
      res.status(err.statusCode).json({ error: err.message, ...(err.extra ?? {}) });
      return;
    }
    next(err);
  } finally {
    if (deadline) clearTimeout(deadline);
  }
});
