/**
 * Every plugin's settings for an AI (src/core/plugins/plugin-settings.ts), behind the
 * `plugin_settings` and `plugin_settings_set` ops:
 *
 *   GET   /api/v1/plugin-settings          every plugin, one line each
 *   GET   /api/v1/plugin-settings/:plugin  one plugin's fields, values masked, where its page is
 *   PATCH /api/v1/plugin-settings/:plugin  { set?: {key: value}, unset?: [key] }, all or nothing
 *
 * `:plugin` is an id or a name. Config is the leader's: a replica refuses the write.
 */

import { Router, type Request, type Response } from 'express'
import { changedBy } from './changed-by.js'
import { PluginSettingsError, applyPluginSettings, listPluginSettings, readPluginSettings } from '../../core/plugins/plugin-settings.js'
import { role } from '../../core/server-role.js'
import { log } from '../../logging/index.js'
import { sendLinkFailure } from '../middleware/link-failure-answer.js'

export const pluginSettingsV1Router = Router()

function fail(req: Request, res: Response, err: unknown): void {
  // Nothing here reaches a host, but a failure that is one keeps its own answer.
  if (sendLinkFailure(req, res, err)) return
  if (err instanceof PluginSettingsError) {
    res.status(err.status).json({ error: err.message, code: err.code, ...err.extra })
    return
  }
  const message = err instanceof Error ? err.message : String(err)
  log.web.warn('plugin settings failed', { error: message })
  res.status(500).json({ error: message, code: 'internal' })
}

pluginSettingsV1Router.get('/plugin-settings', async (req, res) => {
  try {
    res.json({ plugins: await listPluginSettings() })
  } catch (err) { fail(req, res, err) }
})

pluginSettingsV1Router.get('/plugin-settings/:plugin', async (req, res) => {
  try {
    res.json(await readPluginSettings(String(req.params.plugin)))
  } catch (err) { fail(req, res, err) }
})

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

pluginSettingsV1Router.patch('/plugin-settings/:plugin', async (req, res) => {
  try {
    if (role() !== 'leader') {
      res.status(501).json({ error: 'Plugin settings are changed on the Walnut that holds them (your Mac), not on this replica.', code: 'not_on_replica' })
      return
    }
    // A test run never changes the person's config (core/test-run.ts).
    const { ambientTestRun } = await import('../../core/test-run.js')
    if (ambientTestRun()) {
      res.status(409).json({ error: 'A test run does not change plugin settings.', code: 'test_run' })
      return
    }
    const body = isRecord(req.body) ? req.body : {}
    const set = body.set
    const unset = body.unset
    if (set !== undefined && !isRecord(set)) { res.status(400).json({ error: 'set is an object of setting keys to values.', code: 'bad_set' }); return }
    if (unset !== undefined && !(Array.isArray(unset) && unset.every((k) => typeof k === 'string'))) {
      res.status(400).json({ error: 'unset is a list of setting keys.', code: 'bad_unset' }); return
    }
    if (Object.keys(set ?? {}).length === 0 && (unset ?? []).length === 0) {
      res.status(400).json({ error: 'Name at least one setting in set or unset.', code: 'empty_change' }); return
    }
    const by = await changedBy(req)
    const result = await applyPluginSettings(String(req.params.plugin), { set: set as Record<string, unknown> | undefined, unset: unset as string[] | undefined }, { by })
    if (result.written) {
      log.web.info('plugin settings changed', { pluginId: result.plugin, by, keys: result.changes.map((c) => c.key) })
    }
    // A refusal is an answer, not an error: its body says which key and why (the op reports it failed).
    res.json(result)
  } catch (err) { fail(req, res, err) }
})
