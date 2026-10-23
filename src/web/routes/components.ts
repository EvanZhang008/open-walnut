/**
 * Components API: what each optional part's status is, and turning one on.
 *
 *   GET  /api/components               { platform, components: ComponentStatus[] }
 *   GET  /api/components/:name         ComponentStatus
 *   POST /api/components/:name/install starts the download (202), answers at once
 *
 * Both reads come from memory; the install runs in the background and the
 * settings rows poll the status while it does.
 */

import { Router, type Request, type Response } from 'express'
import {
  COMPONENT_NAMES, componentStatus, ensureComponent, initComponents, listComponentStatuses, type ComponentName,
} from '../../core/components/index.js'
import { currentPlatformSync } from '../../core/components/platform.js'

export const componentsRouter = Router()

function nameOf(req: Request): ComponentName | null {
  const name = String(req.params.name ?? '')
  return (COMPONENT_NAMES as readonly string[]).includes(name) ? name as ComponentName : null
}

componentsRouter.get('/', async (_req: Request, res: Response) => {
  await initComponents()
  res.json({ platform: currentPlatformSync(), components: listComponentStatuses() })
})

componentsRouter.get('/:name', async (req: Request, res: Response) => {
  const name = nameOf(req)
  if (!name) { res.status(404).json({ error: 'unknown component' }); return }
  await initComponents()
  res.json(componentStatus(name))
})

componentsRouter.post('/:name/install', async (req: Request, res: Response) => {
  const name = nameOf(req)
  if (!name) { res.status(404).json({ error: 'unknown component' }); return }
  await initComponents()
  const before = componentStatus(name)
  if (before.state === 'unsupported') { res.status(409).json(before); return }
  void ensureComponent(name, 'user')
  res.status(before.state === 'ready' ? 200 : 202).json(componentStatus(name))
})
