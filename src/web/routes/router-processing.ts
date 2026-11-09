import { Router, type Request, type Response, type NextFunction } from 'express';
import { readAssignedItem, recordAreaWork } from '../../core/router/processing.js';
import { RouterAreaError } from '../../core/router/areas.js';
import { RouterError } from '../../core/router/service.js';
import { ReportChangeError } from '../../core/sessions/report-set.js';
import { sendV1Error } from './v1-control-relay.js';
import { role } from '../../core/server-role.js';
import { ambientTestRun } from '../../core/test-run.js';
import { ROUTER_SOURCE_KINDS, type RouterSource } from '../../core/router/types.js';

export const routerProcessingRouter = Router();
const sid = (req: Request) => typeof req.headers['x-walnut-caller-sid'] === 'string' ? req.headers['x-walnut-caller-sid'] : undefined;
const primary = () => { if (role() === 'replica') throw new RouterError('not_supported_cloud', 'Incoming-item work stays on the primary.', 501); };
function fail(res: Response, next: NextFunction, error: unknown) {
  if (error instanceof RouterError || error instanceof RouterAreaError || error instanceof ReportChangeError) sendV1Error(res, error.status, error.code, error.message);
  else if ((error as { code?: string })?.code === 'source_changed') {
    sendV1Error(res, 409, 'source_changed', error instanceof Error ? error.message : String(error));
  } else if (['source_missing', 'source_unavailable'].includes((error as { code?: string })?.code ?? '')) {
    sendV1Error(res, 503, 'source_unavailable', error instanceof Error ? error.message : String(error));
  } else next(error);
}
routerProcessingRouter.get('/router/item', async (req, res, next) => {
  try {
    primary();
    const { kind, account, message, version } = req.query;
    if (typeof kind !== 'string' || !(ROUTER_SOURCE_KINDS as readonly string[]).includes(kind)
      || typeof account !== 'string' || !account.trim() || account.length > 320
      || typeof message !== 'string' || !message.trim() || message.length > 1000) throw new RouterError('source_required', 'Name the exact source kind, account and message.');
    if (version !== undefined && (typeof version !== 'string' || !version || version.length > 200 || /[\u0000-\u001f\u007f]/.test(version))) {
      throw new RouterError('source_required', 'Give a valid cached delivery version.');
    }
    res.json(await readAssignedItem({ kind, account, message, ...(typeof version === 'string' ? { version } : {}) } as RouterSource, sid(req)));
  } catch (error) { fail(res, next, error); }
});
routerProcessingRouter.post('/router/work', async (req, res, next) => {
  try {
    primary();
    if (ambientTestRun()) throw new RouterError('test_run', 'A test run changes no real receiving task.', 409);
    res.json(await recordAreaWork(req.body ?? {}, sid(req)));
  } catch (error) { fail(res, next, error); }
});
