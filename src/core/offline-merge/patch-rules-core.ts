/**
 * The field rules of a task write, as `PATCH /api/v1/tasks/:id` checks them
 * (src/web/routes/api-v1.ts), in ONE place for every writer that checks before it
 * journals and for the Mac that checks again when it drains:
 *
 *   - the Mac's drain (patch-check.ts checkResolvedPatch, inside the row's write lock);
 *   - the host replica's write port (src/replica/write-port.ts macRefusalOf).
 *
 * Self-contained on purpose: nothing here references anything at module scope, so a
 * writer away from the Mac checks with the Mac's own lists, which arrive as `rules`
 * (its phases, statuses, priorities and tiers, custom ones included). The answer is the
 * refusal's sentence, or null.
 *
 * Two normalizations the route also makes, on `patch` in place: a wait clock on a task
 * that is not (or no longer) WAITING is dropped, and clearing start_date clears an
 * end_date left without one.
 */

export interface TaskPatchRules {
  phases: readonly string[]
  statuses: readonly string[]
  priorities: readonly string[]
  /** Every tier a task may be filed in: the built-in ones and the board's custom ones. */
  tiers: readonly string[]
}

export interface TaskPatchContext {
  /** The plugin content check (task-manager.ts runPluginContentValidation); throws on a rejection. */
  validateContent?: (task: Record<string, unknown>, field: string, value: string) => void
}

/** The route's refusal of `patch` on `current`, or null when it takes it (normalizing `patch`). */
export function taskPatchRefusal(
  current: Readonly<Record<string, unknown>>, patch: Record<string, unknown>, rules: TaskPatchRules, ctx: TaskPatchContext = {},
): string | null {
  const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})?)?$/
  const isIso = (s: unknown): boolean => {
    if (typeof s !== 'string' || !ISO_DATE_RE.test(s) || Number.isNaN(Date.parse(s))) return false
    const day = s.slice(0, 10)
    return new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day
  }
  const isClear = (v: unknown): boolean => v === '' || v === null || v === undefined
  const has = (f: string): boolean => Object.prototype.hasOwnProperty.call(patch, f)
  if (has('phase') && !(typeof patch.phase === 'string' && rules.phases.indexOf(patch.phase) !== -1)) return `phase must be one of: ${rules.phases.join(', ')}`
  if (has('status') && !(typeof patch.status === 'string' && rules.statuses.indexOf(patch.status) !== -1)) return `status must be one of: ${rules.statuses.join(', ')}`
  if (has('priority') && !(typeof patch.priority === 'string' && rules.priorities.indexOf(patch.priority) !== -1)) return `priority must be one of: ${rules.priorities.join(', ')}`
  if (has('title')) {
    if (!(typeof patch.title === 'string' && patch.title.trim())) return 'title must be a non-empty string'
    if ((patch.title as string).length > 500) return 'title too long (max 500 chars)'
  }
  for (const f of ['description', 'note', 'summary', 'sprint']) if (has(f) && !isClear(patch[f]) && typeof patch[f] !== 'string') return `${f} must be a string`
  for (const f of ['project', 'group_id', 'parent_task_id']) if (has(f) && !isClear(patch[f]) && typeof patch[f] !== 'string') return `${f} must be a string`
  if (has('tags') && !isClear(patch.tags) && !(Array.isArray(patch.tags) && patch.tags.every((t) => typeof t === 'string'))) return 'tags must be an array of strings'
  if (has('depends_on') && !isClear(patch.depends_on) && !(Array.isArray(patch.depends_on) && patch.depends_on.every((t) => typeof t === 'string'))) {
    return 'depends_on must be an array of task ids'
  }
  for (const f of ['unread', 'pinned']) if (has(f) && patch[f] !== undefined && typeof patch[f] !== 'boolean') return `${f} must be a boolean`
  if (has('pin_order') && !isClear(patch.pin_order) && !(typeof patch.pin_order === 'number' && Number.isFinite(patch.pin_order))) return 'pin_order must be a number'
  if (has('focus_tier') && !isClear(patch.focus_tier)) {
    const tier = patch.focus_tier
    if (typeof tier !== 'string' || rules.tiers.indexOf(tier) === -1) return `focus_tier ${String(tier)} is not a tier on this board`
  }
  for (const f of ['due_date', 'start_date', 'end_date']) if (has(f) && !isClear(patch[f]) && !isIso(patch[f])) return `${f} must be an ISO-8601 date string, or "" to clear`
  if (has('wait_until') && !isClear(patch.wait_until) && !isIso(patch.wait_until)) return 'wait_until must be an ISO-8601 datetime, or "" to clear'
  if (has('watched_at') && !isClear(patch.watched_at) && !isIso(patch.watched_at)) return 'watched_at must be an ISO-8601 datetime, or "" to stop watching'
  if (has('background_at') && !isClear(patch.background_at) && !isIso(patch.background_at)) return 'background_at must be an ISO-8601 datetime, or "" to take it out of Background'
  // wait_until belongs to WAITING alone: a clock the merge kept onto a task that is not
  // (the Mac moved it on later) is dropped, never written as a stray clock.
  const phase = has('phase') ? patch.phase : current.phase
  if (has('wait_until') && !isClear(patch.wait_until) && phase !== 'WAITING') delete patch.wait_until
  // The working block, judged on the EFFECTIVE row (one half may be all the patch has).
  const start = has('start_date') ? (isClear(patch.start_date) ? undefined : String(patch.start_date)) : (current.start_date as string | undefined) || undefined
  let end = has('end_date') ? (isClear(patch.end_date) ? undefined : String(patch.end_date)) : (current.end_date as string | undefined) || undefined
  if (has('start_date') && !start && end && !has('end_date')) { patch.end_date = null; end = undefined }
  if (end && !start) return 'end_date requires a start_date (it is the end of a start_date working block)'
  if (end && start && Date.parse(end) < Date.parse(start)) return 'end_date must be greater than or equal to start_date'
  if (ctx.validateContent && current.source !== 'local') {
    for (const f of ['title', 'description', 'note']) {
      if (has(f) && typeof patch[f] === 'string') {
        try { ctx.validateContent(current, f, patch[f] as string) } catch (err) { return err instanceof Error ? err.message : String(err) }
      }
    }
  }
  return null
}
