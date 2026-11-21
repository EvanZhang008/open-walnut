/**
 * /api/v1/focus-spaces: the person's focus spaces (src/core/focus-spaces/), the same for a
 * person in the console and the phone and for an agent through the `api` op.
 *
 *   GET    /focus-spaces                 → { spaces, active, apps } (apps: the plugins with an App,
 *                                          and what each declares for spaces: focus-spaces/apps.ts)
 *   POST   /focus-spaces                 { name, projects?, tasks?, apps? } → { space }
 *   PATCH  /focus-spaces/:id             { name?, projects?, tasks?, apps? } → { space }
 *   DELETE /focus-spaces/:id             → { removed } (a focus in it ends)
 *   PUT    /focus-spaces/active          { spaceId } | { scope, name? }, until?, by? → { active }
 *   DELETE /focus-spaces/active[?only_by=block] → { ended } (only_by: leave only a focus that
 *                                          one entered, never one the person chose since)
 *
 * Experiment `focus_workspace`: 404 while it is off, and a focus left on when it was turned off
 * ends at the next read. Replica: reads only (writes answer 501).
 *
 * A test run keeps its spaces and its focus in its own copy (test-run-prefs.ts): entering a
 * focus holds the user's notifications, the phone's too, so a spec must never do that for real.
 */
import { Router, type Request, type Response, type NextFunction } from 'express'
import { isFollower } from '../../core/server-role.js'
import { sendError } from './cloud-send-words.js'
import { experimentCache } from '../../core/experimental-cache.js'
import { testRunPrefsRead, testRunPrefsWrite } from '../../core/test-run-prefs.js'
import {
  FocusSpaceError, MAX_FOCUS_SPACES, createFocusSpace, deleteFocusSpace, listFocusSpaces,
  newFocusSpace, patchFocusSpace, updateFocusSpace, type FocusSpace,
} from '../../core/focus-spaces/store.js'
import {
  FOCUS_BY, enterFocus, followSpaceChange, getActiveFocus, leaveFocus, resolveFocus, type ActiveFocus,
} from '../../core/focus-spaces/active.js'

export const focusSpacesV1Router = Router()

const flag = experimentCache('focus_workspace')

/** A test run's copy: absent = it changed nothing yet (it reads the user's own). */
interface RunFocus { spaces?: FocusSpace[]; active?: ActiveFocus | null }

async function runSpaces(own: RunFocus): Promise<FocusSpace[]> {
  if (!own.spaces) own.spaces = await listFocusSpaces()
  return own.spaces
}

async function runActive(own: RunFocus): Promise<ActiveFocus | null> {
  if (own.active === undefined) own.active = await getActiveFocus()
  if (own.active?.until !== undefined && own.active.until <= Date.now()) own.active = null
  return own.active
}

/** Gate every route: off answers 404, as a route that does not exist. */
focusSpacesV1Router.use('/focus-spaces', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    if (await flag.on()) return next()
    // Turned off in the middle of a focus: the hold must not outlive the switch.
    if (!testRunPrefsRead<RunFocus>('focus-spaces') && await getActiveFocus()) await leaveFocus()
    sendError(res, 404, 'experiment_off', 'Focus spaces are an experiment that is off (Settings > Experimental).')
  } catch (err) { next(err) }
})

function writeGuard(res: Response): boolean {
  if (!isFollower()) return true
  sendError(res, 501, 'not_supported_cloud', 'Focus spaces are changed on the primary box')
  return false
}

function failed(res: Response, err: unknown, next: NextFunction): void {
  if (err instanceof FocusSpaceError) {
    const status = err.code === 'not_found' ? 404 : err.code === 'too_many' ? 409 : 400
    sendError(res, status, err.code, err.message)
    return
  }
  next(err)
}

focusSpacesV1Router.get('/focus-spaces', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const own = testRunPrefsRead<RunFocus>('focus-spaces')
    const spaces = own?.spaces ?? await listFocusSpaces()
    const active = own && own.active !== undefined ? await runActive(own) : await getActiveFocus()
    const { focusApps } = await import('../../core/focus-spaces/apps.js')
    res.json({ spaces, active, apps: await focusApps().catch(() => []) })
  } catch (err) { next(err) }
})

focusSpacesV1Router.put('/focus-spaces/active', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!writeGuard(res)) return
    const body = (req.body ?? {}) as Record<string, unknown>
    const input = {
      ...(typeof body.spaceId === 'string' ? { spaceId: body.spaceId } : {}),
      scope: body.scope, name: body.name, until: body.until, by: body.by,
    }
    const own = testRunPrefsWrite<RunFocus>('focus-spaces', () => ({}))
    if (own) {
      const spaces = await runSpaces(own)
      own.active = await resolveFocus(input, await runActive(own), async (id) => spaces.find((s) => s.id === id) ?? null)
      res.json({ active: own.active })
      return
    }
    res.json({ active: await enterFocus(input) })
  } catch (err) { failed(res, err, next) }
})

focusSpacesV1Router.delete('/focus-spaces/active', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!writeGuard(res)) return
    const onlyBy = FOCUS_BY.find((b) => b === req.query.only_by)
    const own = testRunPrefsWrite<RunFocus>('focus-spaces', () => ({}))
    if (own) {
      const was = await runActive(own)
      if (!was || (onlyBy && was.by !== onlyBy)) { res.json({ ended: null }); return }
      own.active = null
      res.json({ ended: was })
      return
    }
    res.json({ ended: await leaveFocus(onlyBy ? { onlyBy } : {}) })
  } catch (err) { failed(res, err, next) }
})

focusSpacesV1Router.post('/focus-spaces', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!writeGuard(res)) return
    const own = testRunPrefsWrite<RunFocus>('focus-spaces', () => ({}))
    if (own) {
      const spaces = await runSpaces(own)
      if (spaces.length >= MAX_FOCUS_SPACES) throw new FocusSpaceError('too_many', `At most ${MAX_FOCUS_SPACES} focus spaces.`)
      const space = newFocusSpace(req.body ?? {})
      own.spaces = [...spaces, space]
      res.status(201).json({ space })
      return
    }
    res.status(201).json({ space: await createFocusSpace(req.body ?? {}) })
  } catch (err) { failed(res, err, next) }
})

focusSpacesV1Router.patch('/focus-spaces/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!writeGuard(res)) return
    const id = String(req.params.id)
    const own = testRunPrefsWrite<RunFocus>('focus-spaces', () => ({}))
    if (own) {
      const spaces = await runSpaces(own)
      const at = spaces.findIndex((s) => s.id === id)
      if (at < 0) throw new FocusSpaceError('not_found', 'No such focus space.')
      const space = patchFocusSpace(spaces[at], req.body ?? {})
      own.spaces = spaces.map((s, i) => (i === at ? space : s))
      const active = await runActive(own)
      if (active?.spaceId === id) {
        own.active = await resolveFocus({ spaceId: id, by: active.by, until: active.until }, active, async () => space)
      }
      res.json({ space })
      return
    }
    const space = await updateFocusSpace(id, req.body ?? {})
    await followSpaceChange(id)
    res.json({ space })
  } catch (err) { failed(res, err, next) }
})

focusSpacesV1Router.delete('/focus-spaces/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!writeGuard(res)) return
    const id = String(req.params.id)
    const own = testRunPrefsWrite<RunFocus>('focus-spaces', () => ({}))
    if (own) {
      const spaces = await runSpaces(own)
      own.spaces = spaces.filter((s) => s.id !== id)
      if ((await runActive(own))?.spaceId === id) own.active = null
      res.json({ removed: own.spaces.length !== spaces.length })
      return
    }
    const removed = await deleteFocusSpace(id)
    if (removed) await followSpaceChange(id)
    res.json({ removed })
  } catch (err) { failed(res, err, next) }
})

