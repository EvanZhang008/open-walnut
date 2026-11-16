/**
 * Walnut subagents of the calling session (core/subagents). Additive to v1.
 *
 *   POST /api/v1/subagents            { engine?, host?, cwd?, model?, effort?, prompt, description?, background?, timeout_min?, wait_ms?, tool_use_id? }
 *                                     → the run: its answer when it ended within the wait, else state running
 *   POST /api/v1/subagents/:id/message { message, background?, wait_ms? } → its answer to the message, as above
 *   GET  /api/v1/subagents            → { subagents } this session's runs, running and recent
 *   GET  /api/v1/subagents/:id?wait_ms= → the run, after waiting up to wait_ms for it to end
 *   POST /api/v1/subagents/:id/stop   → { stopped, state }
 *
 * The caller is the session in `x-walnut-caller-sid`. A wait never outlasts the caller's
 * own deadline (src/lib/answer-by.ts: a session on another host, whose gateway gives up
 * at 20 s), so a long run answers "running" in time; its answer then comes into the caller's
 * session by itself when it ends (registry.ts tellParent), nothing has to read it.
 */
import { Router, type Request, type Response, type NextFunction } from 'express'
import { isFollower } from '../../core/server-role.js'

export const subagentsV1Router = Router()

/** The longest one call waits for a run. */
export const MAX_WAIT_MS = 10 * 60_000
/** Kept back from the caller's deadline for the answer's way home. */
const DEADLINE_MARGIN_MS = 3_000

function callerSid(req: Request): string | undefined {
  const raw = req.headers['x-walnut-caller-sid']
  const sid = Array.isArray(raw) ? raw[0] : raw
  return typeof sid === 'string' && sid.trim() ? sid.trim() : undefined
}

function waitFor(raw: unknown, fallback: number, deadline: number | undefined): number {
  const asked = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : fallback
  const capped = Math.min(MAX_WAIT_MS, Math.max(0, asked))
  return deadline === undefined ? capped : Math.max(0, Math.min(capped, deadline - Date.now() - DEADLINE_MARGIN_MS))
}

async function answer(req: Request, res: Response, next: NextFunction, work: (deadline: number | undefined) => Promise<unknown>): Promise<void> {
  if (isFollower()) {
    res.status(404).json({ error: 'Subagents run through the Mac', code: 'leader_only' })
    return
  }
  const [{ LightSubagentError }, { ANSWER_BY_HEADER, parseAnswerBy }] = await Promise.all([
    import('../../core/subagents/types.js'), import('../../lib/answer-by.js'),
  ])
  try {
    res.json(await work(parseAnswerBy(req.headers[ANSWER_BY_HEADER])))
  } catch (err) {
    if (err instanceof LightSubagentError) {
      res.status(err.status).json({ error: err.message, code: err.code, ...err.data })
      return
    }
    next(err)
  }
}

subagentsV1Router.post('/subagents', (req, res, next) => answer(req, res, next, async (deadline) => {
  const reg = await import('../../core/subagents/registry.js')
  const { LightSubagentError } = await import('../../core/subagents/types.js')
  const b = (req.body ?? {}) as Record<string, unknown>
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
  if (typeof b.prompt !== 'string') throw new LightSubagentError('bad_request', 'prompt is required', 400)
  const run = await reg.startLightSubagent(callerSid(req), {
    ...(str(b.engine) ? { engine: str(b.engine) } : {}),
    ...(str(b.host) ? { host: str(b.host) } : {}),
    ...(str(b.cwd) ? { cwd: str(b.cwd) } : {}),
    prompt: b.prompt,
    ...(str(b.model) ? { model: str(b.model) } : {}),
    ...(str(b.effort) ? { effort: str(b.effort) } : {}),
    ...(str(b.description) ? { description: str(b.description) } : {}),
    background: b.background === true,
    ...(typeof b.timeout_min === 'number' ? { timeoutMin: b.timeout_min } : {}),
    ...(str(b.tool_use_id) ? { toolUseId: str(b.tool_use_id) } : {}),
  })
  await reg.waitLightSubagent(run, waitFor(b.wait_ms, run.background ? 0 : MAX_WAIT_MS, deadline))
  return view(reg, run)
}))

subagentsV1Router.get('/subagents', (req, res, next) => answer(req, res, next, async () => {
  const reg = await import('../../core/subagents/registry.js')
  const sid = callerSid(req)
  return { subagents: sid ? reg.listLightSubagents(sid).map((r) => view(reg, r, { peek: true })) : [] }
}))

subagentsV1Router.get('/subagents/:id', (req, res, next) => answer(req, res, next, async (deadline) => {
  const reg = await import('../../core/subagents/registry.js')
  const run = reg.getLightSubagent(callerSid(req), String(req.params.id))
  await reg.waitLightSubagent(run, waitFor(req.query.wait_ms, 0, deadline))
  return view(reg, run)
}))

subagentsV1Router.post('/subagents/:id/message', (req, res, next) => answer(req, res, next, async (deadline) => {
  const reg = await import('../../core/subagents/registry.js')
  const { LightSubagentError } = await import('../../core/subagents/types.js')
  const b = (req.body ?? {}) as Record<string, unknown>
  if (typeof b.message !== 'string') throw new LightSubagentError('bad_request', 'message is required', 400)
  const { run, turn } = reg.sendLightSubagent(callerSid(req), String(req.params.id), { message: b.message })
  await reg.waitLightSubagent(run, waitFor(b.wait_ms, b.background === true ? 0 : MAX_WAIT_MS, deadline), turn)
  return view(reg, run, { turn })
}))

subagentsV1Router.post('/subagents/:id/stop', (req, res, next) => answer(req, res, next, async () => {
  const reg = await import('../../core/subagents/registry.js')
  const sid = callerSid(req)
  const { stopped, status } = reg.stopLightSubagent(sid, String(req.params.id), sid ? 'its session' : 'the user')
  return { id: String(req.params.id), stopped, state: status }
}))

type Registry = typeof import('../../core/subagents/registry.js')

/**
 * A run as the caller reads it, at caller turn `turn` (default: the latest it was asked): that
 * turn's answer as it ended, else running. Returning a turn's end tells the parent it has it
 * (unless `peek`), so its notice is not sent too.
 */
function view(reg: Registry, run: import('../../core/subagents/registry.js').LightSubagentRun, o: { peek?: boolean; turn?: number } = {}): Record<string, unknown> {
  const turn = o.turn ?? run.turns
  const ended = reg.turnResult(run, turn)
  if (!o.peek && ended) reg.markTold(run, turn)
  // Closed before this message ran (an earlier turn failed or was stopped, or it was closed).
  const missed = !ended && run.closed
  const state = ended ? ended.status : missed ? 'stopped' : 'running'
  const error = ended?.error ?? (missed ? `It was closed before this message ran${run.error ? ` (${run.error})` : ''}` : undefined)
  // What it says now belongs to this turn only while this turn is the one running.
  const current = !ended && !missed && run.turnsEnded === turn - 1 && run.status === 'running'
  return {
    id: run.id,
    state,
    open: !run.closed,
    turn,
    turns: run.turns,
    engine: run.engine,
    ...(run.model ? { model: run.model } : {}),
    ...(run.effort ? { effort: run.effort } : {}),
    host: run.host,
    ...(run.fromHost ? { from_host: run.fromHost } : {}),
    description: run.description,
    elapsed_ms: (run.endedAt ?? Date.now()) - run.startedAt,
    tool_uses: run.toolUses,
    ...(run.lastTool ? { last_tool: run.lastTool } : {}),
    ...(run.tokens ? { tokens: run.tokens } : {}),
    ...(state === 'completed' ? { answer: ended?.answer ?? '' } : {}),
    ...(current && run.text ? { saying: run.text.slice(-1_500) } : {}),
    ...(error ? { error, code: ended?.errorCode ?? (missed ? 'closed' : undefined) } : {}),
    ...(run.warnings.length ? { warnings: run.warnings } : {}),
    ...(run.files.length ? { files: run.files } : {}),
    ...(run.work.length ? { work: run.work } : {}),
    full_access: run.fullAccess,
  }
}
