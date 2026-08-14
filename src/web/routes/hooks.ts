/**
 * /api/hooks — unified hook inventory, toggles, and per-hook settings.
 *
 * GET  /api/hooks      → HookInfo[] (dispatcher hooks + daemon policies + inline)
 * PATCH /api/hooks/:id → { enabled?, priority?, timeoutMs?, settings? }
 *   - mutable=config-override → writes hooks.overrides[id] (live reload via CONFIG_CHANGED)
 *   - mutable=config-path (daemon) → flips the dedicated config key; responds
 *     requiresDaemonRestart:true (env is read at daemon spawn)
 *   - mutable=readonly → 409
 *   - `settings` writes the hook's declared knobs (hooks/settings.ts) to their
 *     own config paths — so a hook with parameters is configured HERE, not in a
 *     hand-written block in some other settings section.
 *
 * ⚠ updateConfig() replaces TOP-LEVEL keys wholesale — every write here reads
 * the current config and writes back the FULLY-MERGED top-level object
 * (a naive { hooks: { overrides: {...} } } would wipe hooks.defs). The merge is
 * RECURSIVE: a policy whose config key is two levels deep would otherwise erase
 * its own siblings (shipped bug, caught in real-UI verification).
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { getConfig, updateConfig } from '../../core/config-manager.js'
import { getHookInventory } from '../../core/hooks/registry.js'
import { DAEMON_POLICIES } from '../../core/hooks/daemon-policies.js'
import { buildSettingsPatch, mergeTopLevel } from '../../core/hooks/settings.js'
import { bus, EventNames } from '../../core/event-bus.js'
import { log } from '../../logging/index.js'

export const hooksRouter = Router()

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
    const { enabled, priority, timeoutMs, settings } = req.body as {
      enabled?: unknown; priority?: unknown; timeoutMs?: unknown; settings?: unknown;
    }
    if (enabled !== undefined && typeof enabled !== 'boolean') {
      res.status(400).json({ error: 'enabled must be a boolean' })
      return
    }
    if (settings !== undefined
      && (typeof settings !== 'object' || settings === null || Array.isArray(settings))) {
      res.status(400).json({ error: 'settings must be an object of { key: value }' })
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
      // Daemon policy — flip its dedicated config key and/or write its declared
      // settings, both through the descriptor so this route stays policy-agnostic.
      const policy = DAEMON_POLICIES.find(p => p.id === id)
      if (!policy) {
        res.status(404).json({ error: `Unknown daemon policy "${id}"` })
        return
      }
      if (enabled === undefined && settings === undefined) {
        res.status(400).json({ error: 'Daemon policies accept { enabled } and/or { settings }' })
        return
      }
      if (enabled !== undefined && !policy.setter) {
        res.status(409).json({ error: `Hook "${id}" cannot be toggled`, note: policy.note })
        return
      }
      if (settings !== undefined && !policy.settings?.length) {
        res.status(400).json({ error: `Hook "${id}" has no settings` })
        return
      }

      const current = config as unknown as Record<string, unknown>
      // Fold enable + settings into ONE write: two sequential updateConfig calls
      // would each read-modify-write the same top-level `session` key, and the
      // second would be based on a snapshot taken before the first landed.
      let merged: Record<string, unknown> = {}
      if (enabled !== undefined) {
        merged = mergeTopLevel(current, policy.setter!(enabled) as Record<string, unknown>)
      }
      if (settings !== undefined) {
        const built = buildSettingsPatch(
          policy.settings!,
          settings as Record<string, unknown>,
          // Base the settings merge on the enable-merged view so both survive.
          { ...current, ...merged },
        )
        if (!built.ok) {
          res.status(400).json({ error: built.error })
          return
        }
        merged = { ...merged, ...built.patch }
      }
      await updateConfig(merged)
      log.web.info('daemon policy updated via /api/hooks', {
        id, enabled, settingKeys: settings ? Object.keys(settings as object) : undefined,
      })
      const fresh = await getHookInventory()
      res.json({
        ok: true, id, enabled, requiresDaemonRestart: true, note: policy.note,
        settings: fresh.find(h => h.id === id)?.settings,
      })
      return
    }

    if (settings !== undefined) {
      // Only daemon policies declare settings today. Reject rather than silently
      // ignore, so a UI wiring mistake is loud instead of a no-op write.
      res.status(400).json({ error: `Hook "${id}" does not support settings` })
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
