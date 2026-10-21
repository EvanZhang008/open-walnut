/**
 * /api/v1 trigger templates: the ready-made triggers plugins offer
 * (src/core/routines/trigger-templates.ts).
 *
 *   GET  /trigger-templates                         → { templates }
 *   GET  /trigger-templates/:id/options?param=&q=   → { options }
 *   POST /trigger-templates/:id/check { params, input } → the check contract object
 *
 * The check route is what `walnut trigger-check` calls from this machine's
 * daemon on every run. Arming one goes through POST /routines/trigger with
 * `template` + `params`, like every other trigger.
 *
 * A cloud companion runs no plugin templates (the plugins that own the data run
 * on the primary), so it lists none; a create still relays to the primary.
 */
import { Router, type Request, type Response, type NextFunction } from 'express'
import { placement } from '../../core/server-role.js'
import { log } from '../../logging/index.js'
import { sendV1Error as sendError } from './v1-control-relay.js'
import { requestOrigin } from '../middleware/request-origin.js'

export const triggerTemplatesV1Router = Router()

function templateId(req: Request): string {
  return String(req.params.id ?? '')
}

async function answerError(res: Response, err: unknown): Promise<boolean> {
  const { TriggerTemplateError } = await import('../../core/routines/trigger-templates.js')
  if (!(err instanceof TriggerTemplateError)) return false
  const code = err.status === 404 ? 'not_found' : err.status === 400 ? 'bad_request' : err.status === 403 ? 'forbidden'
    : err.status === 504 ? 'timeout' : 'plugin_error'
  sendError(res, err.status, code, err.message)
  return true
}

triggerTemplatesV1Router.get('/trigger-templates', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    if (placement() === 'cloud') {
      res.json({ templates: [] })
      return
    }
    const { listTriggerTemplates } = await import('../../core/routines/trigger-templates.js')
    res.json({ templates: listTriggerTemplates() })
  } catch (err) {
    next(err)
  }
})

triggerTemplatesV1Router.get('/trigger-templates/:id/options', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { templateOptions } = await import('../../core/routines/trigger-templates.js')
    const param = typeof req.query.param === 'string' ? req.query.param : ''
    const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 200) : ''
    res.json({ options: await templateOptions(templateId(req), param, q, requestOrigin(req)) })
  } catch (err) {
    if (await answerError(res, err)) return
    next(err)
  }
})

triggerTemplatesV1Router.post('/trigger-templates/:id/check', async (req: Request, res: Response, next: NextFunction) => {
  const id = templateId(req)
  const started = Date.now()
  try {
    if (placement() === 'cloud') {
      // The plugins run on the primary; a check reaching a leading companion
      // waits for it (the CLI keeps the cursor on a 503), never "no such template".
      sendError(res, 503, 'unavailable', 'trigger templates run on the primary Walnut, which is away')
      return
    }
    const { runTemplateCheck } = await import('../../core/routines/trigger-templates.js')
    const body = (req.body ?? {}) as { params?: unknown; input?: unknown }
    const result = await runTemplateCheck(id, body.params, body.input, requestOrigin(req))
    log.web.debug('trigger template check', {
      template: id, fire: result.fire, items: result.items?.length ?? 0, ms: Date.now() - started,
    })
    res.json(result)
  } catch (err) {
    log.web.warn('trigger template check failed', {
      template: id, ms: Date.now() - started, error: err instanceof Error ? err.message : String(err),
    })
    if (await answerError(res, err)) return
    next(err)
  }
})
