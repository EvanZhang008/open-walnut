import { Router, type Request, type Response, type NextFunction } from 'express';
import { isFollower } from '../../core/server-role.js';
import { requestOrigin } from '../middleware/request-origin.js';
import { humanActionApiBase } from '../../ops/human-action-policy.js';
import { sendV1Error, callPrimaryControl } from './v1-control-relay.js';
import { ItemActionError } from '../../core/human-inbox/item-ledger.js';

export const humanInboxItemsV1Router = Router();
const ROOT = '/human-inbox/:letter/items/:item';
function param(req: Request, key: string): string { return String(req.params[key] ?? ''); }
async function guard(res: Response, next: NextFunction, fn: () => Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([fn(), new Promise<void>(resolve => { timer = setTimeout(() => {
      if (!res.headersSent) sendV1Error(res, 504, 'status_unavailable', 'Status unavailable. Check again.');
      resolve();
    }, 10_000); })]);
  } catch (error) {
    if (res.headersSent) return;
    if (error instanceof ItemActionError) sendV1Error(res, error.status, error.code, error.message);
    else next(error);
  } finally { if (timer) clearTimeout(timer); }
}
async function relay(req: Request, res: Response, operation: string): Promise<boolean> {
  if (!isFollower()) return false;
  const outcome = await callPrimaryControl(`server.human-inbox.item-${operation}` as Parameters<typeof callPrimaryControl>[0], '__server__', {
    letterId: param(req, 'letter'), itemId: param(req, 'item'), body: req.body, query: req.query, taskId: param(req, 'taskId'),
  }, 8_000);
  if (!outcome.ok) {
    const notSent = 'notSent' in outcome.failure && outcome.failure.notSent === true;
    sendV1Error(res, 503, notSent ? 'primary_unavailable' : 'status_unconfirmed', notSent
      ? 'Primary Walnut unavailable. Nothing was started.' : 'Status unconfirmed. Check status before trying again.', { notSent });
  } else {
    const result = outcome.result as Record<string, unknown>;
    if (result.itemError && typeof result.itemError === 'object') {
      const error = result.itemError as { status: number; code: string; message: string };
      sendV1Error(res, error.status, error.code, error.message);
      return true;
    }
    res.status(operation === 'execute' && (result.receipt as { status?: string })?.status === 'pending' ? 202 : 200).json(result);
  }
  return true;
}
humanInboxItemsV1Router.post(`${ROOT}/prepare`, (req, res, next) => guard(res, next, async () => {
  if (await relay(req, res, 'prepare')) return;
  const { prepareInboxItem } = await import('../../core/human-inbox/item-plans.js');
  const result = await prepareInboxItem(param(req, 'letter'), param(req, 'item'), req.body, requestOrigin(req));
  if (!res.headersSent) res.json(result);
}));
humanInboxItemsV1Router.post(`${ROOT}/execute`, (req, res, next) => guard(res, next, async () => {
  if (await relay(req, res, 'execute')) return;
  const { executeInboxItem, queryInboxItem } = await import('../../core/human-inbox/item-execution.js');
  const receipt = await executeInboxItem(param(req, 'letter'), param(req, 'item'), req.body, requestOrigin(req), humanActionApiBase(req));
  const result = await queryInboxItem(param(req, 'letter'), param(req, 'item'), requestOrigin(req));
  if (!res.headersSent) res.status(receipt.status === 'pending' ? 202 : 200).json({ ...result, receipt });
}));
humanInboxItemsV1Router.get(`${ROOT}/execution`, (req, res, next) => guard(res, next, async () => {
  if (await relay(req, res, 'execution')) return;
  const { queryInboxItem } = await import('../../core/human-inbox/item-execution.js');
  const result = await queryInboxItem(param(req, 'letter'), param(req, 'item'), requestOrigin(req));
  if (!res.headersSent) res.json(result);
}));
humanInboxItemsV1Router.get(`${ROOT}/tasks`, (req, res, next) => guard(res, next, async () => {
  if (await relay(req, res, 'tasks')) return;
  const { storedInboxItem } = await import('../../core/human-inbox/item-plans.js');
  await storedInboxItem(param(req, 'letter'), param(req, 'item'));
  const { itemTaskPage } = await import('../../core/human-inbox/item-status.js');
  const offset = Math.max(0, Math.floor(Number(req.query.offset) || 0));
  const limit = Math.min(100, Math.max(1, Math.floor(Number(req.query.limit) || 25)));
  const result = await itemTaskPage(String(req.query.query ?? req.query.q ?? ''), offset, limit);
  if (!res.headersSent) res.json(result);
}));
humanInboxItemsV1Router.get(`${ROOT}/tasks/:taskId`, (req, res, next) => guard(res, next, async () => {
  if (await relay(req, res, 'task')) return;
  const { storedInboxItem } = await import('../../core/human-inbox/item-plans.js');
  await storedInboxItem(param(req, 'letter'), param(req, 'item'));
  const { itemTaskPreview } = await import('../../core/human-inbox/item-status.js');
  const result = await itemTaskPreview(param(req, 'taskId'));
  if (!res.headersSent) res.json(result);
}));
