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

/** Route deadline: the engine's own timeout is 80s; this outer race answers
 *  the HTTP request either way (the child keeps running to completion and a
 *  retry joins the still-warm cache / in-flight entry). Env override exists
 *  for tests — a 90s wait is untestable wall-clock. */
function routeDeadlineMs(): number {
  const fromEnv = Number(process.env.WALNUT_AGENT_SEARCH_DEADLINE_MS);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 90_000;
}

/** Adopt deadline — much tighter than the search's own, because this request is
 *  a button press holding a browser connection slot, not a background lane.
 *  30s covers a normal search (measured 7s, p90 ~20s) and still lets the client
 *  fall back while the click feels like a click. */
function adoptDeadlineMs(): number {
  const fromEnv = Number(process.env.WALNUT_AGENT_SEARCH_ADOPT_DEADLINE_MS);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 30_000;
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

/**
 * POST /api/search/agent/session — continue a search as a conversation.
 *
 * The lane's engine is a real claude session, so this hands back THAT session
 * (adopted into a task under "Ask Walnut" on first ask) instead of starting a
 * fresh agent that would redo the search. See core/sessions/adopt-search-session.
 *
 * Body: { q }. Keyed by QUERY on purpose — a client can never name the session
 * id it wants adopted.
 *
 * 200 {sessionId, taskId, reused} — open this session
 * 400 {code:'bad_query'} / 404 {code:'no_session'|'no_transcript'} — nothing to
 *     reopen; the client falls back to starting a session normally
 *
 * May WAIT for a search that is still running (the button is meant to be
 * pressable during the lane's spinner), so it is slow by design, never hanging:
 * the wait is bounded by the engine's own timeout.
 */
searchAgentRouter.post('/session', async (req: Request, res: Response, next: NextFunction) => {
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const body = (req.body ?? {}) as { q?: unknown; search?: unknown; progressId?: unknown };
    const q = String(body.q ?? '').trim();
    // Length gates BEFORE anything touches the string: the body limit is 15MB and
    // normalizing a query is a synchronous full-string regex on the one event loop
    // every route shares. Same 400-char ceiling the GET enforces.
    if (!q) {
      res.status(400).json({ error: 'q is required', code: 'bad_query' });
      return;
    }
    if (q.length > 400) {
      res.status(400).json({ error: 'q must be at most 400 characters', code: 'bad_query' });
      return;
    }
    // The client tells us whether it may run a search: false when the human has
    // the ✦ lane switched off (or it just failed), because spending a model run
    // behind an off switch is not ours to decide. Default false — a caller that
    // says nothing gets the cheap answer.
    const maySearch = body.search === true;
    const progressId = typeof body.progressId === 'string' && /^[A-Za-z0-9_-]{6,64}$/.test(body.progressId)
      ? body.progressId : undefined;

    const { adoptAgentSearchSession, AdoptSearchSessionError } =
      await import('../../core/sessions/adopt-search-session.js');
    // Bounded wait, because this response holds one of the browser's six
    // connections: a search can legitimately take 80s, and pinning a slot that
    // long is the shape that starves the whole app (CLAUDE.md's own rule). On
    // expiry the client falls back to launching a session while the search keeps
    // running for the card — and the NEXT press adopts it.
    const timeout = new Promise<never>((_, reject) => {
      deadline = setTimeout(
        () => reject(new AdoptSearchSessionError('the AI search is still running', 404, 'search_pending')),
        adoptDeadlineMs(),
      );
    });
    try {
      res.json(await Promise.race([
        adoptAgentSearchSession(q, { startIfMissing: maySearch, ...(progressId ? { progressId } : {}) }),
        timeout,
      ]));
    } catch (err) {
      if (err instanceof AdoptSearchSessionError) {
        res.status(err.statusCode).json({ error: err.message, code: err.code });
        return;
      }
      throw err;
    }
  } catch (err) {
    next(err);
  } finally {
    if (deadline) clearTimeout(deadline);
  }
});
