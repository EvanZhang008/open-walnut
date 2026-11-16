import type { Request, Response, NextFunction } from 'express';
import { areaOpsForCaller, routerRequestAllowed } from '../../core/router/gateway-policy.js';

export async function routerAreaAccess(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const sid = req.headers['x-walnut-caller-sid'];
    if (typeof sid !== 'string' || !sid.trim()) { next(); return; }
    const ops = await areaOpsForCaller(sid.trim());
    if (!ops) { next(); return; }
    if (!routerRequestAllowed(ops, req.method, req.path, req.query as Record<string, unknown>)) {
      res.status(403).json({ error: 'A router session may use only its routing tools and its lookups: search with types "task", task_get with a task id.', code: 'area_forbidden' });
      return;
    }
    next();
  } catch (error) { next(error); }
}
