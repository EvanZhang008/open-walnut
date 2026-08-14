/**
 * /api/hooks — unified hook inventory + toggles.
 *
 * GET  /api/hooks      → HookInfo[] (dispatcher hooks + daemon policies + inline)
 * PATCH /api/hooks/:id → { enabled?, priority?, timeoutMs? }
 *   - mutable=config-override → writes hooks.overrides[id] (live reload via CONFIG_CHANGED)
 *   - mutable=config-path (daemon) → flips the dedicated config key; responds
 *     requiresDaemonRestart:true (env is read at daemon spawn)
 *   - mutable=readonly → 409
 *
 * ⚠ updateConfig() replaces TOP-LEVEL keys wholesale — every write here reads
 * the current config and writes back the FULLY-MERGED top-level object
 * (a naive { hooks: { overrides: {...} } } would wipe hooks.defs).
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { getConfig, updateConfig } from '../../core/config-manager.js'
import { getHookInventory } from '../../core/hooks/registry.js'
import { DAEMON_POLICIES } from '../../core/hooks/daemon-policies.js'
import { bus, EventNames } from '../../core/event-bus.js'
import { log } from '../../logging/index.js'

export const hooksRouter = Router()

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

/**
 * Recursively merge a patch into the current value, KEEPING every sibling key
 * the patch doesn't mention.
 *
 * Plain objects merge key-by-key; anything else (scalars, arrays) replaces. An
 * array must replace rather than merge: `enabled_modes: ['plan']` means exactly
 * that list, not "add plan to whatever was there".
 */
function deepMerge(current: unknown, patch: unknown): unknown {
  if (!isPlainObject(current) || !isPlainObject(patch)) return patch
  const out: Record<string, unknown> = { ...current }
  for (const [key, value] of Object.entries(patch)) {
    out[key] = deepMerge(current[key], value)
  }
  return out
}

/**
 * Build the updateConfig payload for a daemon-policy toggle.
 *
 * Returns ONLY the top-level keys the patch touches (updateConfig replaces
 * top-level keys wholesale, and sending the whole config back would make every
 * toggle rewrite unrelated sections) — but each of those keys is DEEP-MERGED
 * with its current value, so flipping `session.turn_retry.enabled` preserves
 * both `session.cron_policy` (sibling one level up) and the user's
 * `turn_retry.budget_hours` (sibling inside the patched object).
 */
function deepMergePatch(
  current: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(patch)) {
    out[key] = deepMerge(current[key], value)
  }
  return out
}

hooksRouter.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await getHookInventory())
  } catch (err) {
    next(err)
  }
})

hooksRouter.patch('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id)
    const { enabled, priority, timeoutMs } = req.body as {
      enabled?: unknown; priority?: unknown; timeoutMs?: unknown;
    }
    if (enabled !== undefined && typeof enabled !== 'boolean') {
      res.status(400).json({ error: 'enabled must be a boolean' })
      return
    }
    if (priority !== undefined && typeof priority !== 'number') {
      res.status(400).json({ error: 'priority must be a number' })
      return
    }
    if (timeoutMs !== undefined && typeof timeoutMs !== 'number') {
      res.status(400).json({ error: 'timeoutMs must be a number' })
      return
    }

    const inventory = await getHookInventory()
    const hook = inventory.find(h => h.id === id)
    if (!hook) {
      res.status(404).json({ error: `Unknown hook "${id}"` })
      return
    }
    if (hook.mutable === 'readonly') {
      res.status(409).json({ error: `Hook "${id}" is not toggleable`, note: hook.note })
      return
    }

    const config = await getConfig()

    if (hook.mutable === 'config-path') {
      // Daemon policy — flip its dedicated config key via the descriptor setter.
      const policy = DAEMON_POLICIES.find(p => p.id === id)
      if (!policy?.setter || enabled === undefined) {
        res.status(400).json({ error: 'Daemon policies only support { enabled }' })
        return
      }
      const patch = policy.setter(enabled)
      // Merge nested: the patch's top-level keys replace wholesale in
      // updateConfig, so fold current values in first (session.cron_policy
      // must not wipe session.idle_timeout_minutes etc.).
      //
      // The merge must be RECURSIVE, not one level: a policy whose configPath is
      // two deep (session.turn_retry.enabled) patches
      // { session: { turn_retry: { enabled } } }, and a shallow spread would
      // replace the whole turn_retry object — silently resetting the user's
      // budget_hours / backoff to defaults just because they flipped the toggle.
      await updateConfig(deepMergePatch(config as unknown as Record<string, unknown>, patch))
      log.web.info('daemon policy toggled via /api/hooks', { id, enabled })
      res.json({ ok: true, id, enabled, requiresDaemonRestart: true, note: policy.note })
      return
    }

    // config-override: write hooks.overrides[id], preserving defs + other overrides.
    const hooks = { ...(config.hooks ?? {}) }
    const overrides = { ...(hooks.overrides ?? {}) }
    overrides[id] = {
      ...overrides[id],
      ...(enabled !== undefined ? { enabled } : {}),
      ...(priority !== undefined ? { priority } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    }
    hooks.overrides = overrides
    await updateConfig({ hooks })

    // Nudge the dispatcher's live reload (same event PUT /api/config emits).
    const fresh = await getConfig()
    bus.emit(EventNames.CONFIG_CHANGED, { config: fresh }, ['web-ui'], { source: 'hooks-api' })

    log.web.info('hook override updated via /api/hooks', { id, enabled, priority, timeoutMs })
    res.json({ ok: true, id, override: overrides[id] })
  } catch (err) {
    next(err)
  }
})
