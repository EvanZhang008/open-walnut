import type { Request, Response, NextFunction } from 'express';
import { areaOpsForCaller } from '../../core/router/gateway-policy.js';

export async function routerAreaAccess(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const sid = req.headers['x-walnut-caller-sid'];
    if (typeof sid !== 'string' || !sid.trim()) { next(); return; }
    const ops = await areaOpsForCaller(sid.trim());
    if (!ops) { next(); return; }
    const allowed = (ops.has('router_context') && req.method === 'GET' && req.path === '/v1/router/context')
      || (ops.has('router_route') && req.method === 'POST' && req.path === '/v1/router/route')
      || (ops.has('router_item') && req.method === 'GET' && req.path === '/v1/router/item')
      || (ops.has('router_work') && req.method === 'POST' && req.path === '/v1/router/work');
    if (!allowed) {
      res.status(403).json({ error: 'This scoped session may use only its area routing tools.', code: 'area_forbidden' });
      return;
    }
    next();
  } catch (error) { next(error); }
}
