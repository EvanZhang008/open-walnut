/**
 * Plugin status items (the live items in the console rail).
 *
 *   GET /api/plugin-status-items → { items: PluginStatusItem[] }
 *
 * The first load only; after it the client follows `plugin:status-items`, which carries
 * the same whole list. A button runs through the existing plugin-runtime op route.
 * State lives in src/core/plugins/plugin-status-items.ts.
 */
import { Router, type Request, type Response } from 'express'
import { listStatusItems, type StatusItemsSnapshot } from '../../core/plugins/plugin-status-items.js'

export const pluginStatusItemsRouter = Router()

pluginStatusItemsRouter.get('/', (_req: Request, res: Response) => {
  const body: StatusItemsSnapshot = { items: listStatusItems() }
  res.json(body)
})
