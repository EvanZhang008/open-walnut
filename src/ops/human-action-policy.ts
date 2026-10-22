import type { Request } from 'express';
import type { WalnutOp } from './registry.js';
import { HEALTH_LOCAL_ONLY_MESSAGE, LOCAL_ORIGIN } from '../lib/caller-origin.js';
import { getSelfApiRoot } from '../lib/self-api-root.js';

const POWERFUL = new Set(['task_create', 'task_start', 'task_send', 'session_start', 'session_send', 'memory_write', 'note_write', 'note_edit', 'note_attach']);
const DESTRUCTIVE = new Set(['task_delete', 'task_merge']);
export interface HumanActionRefusal { status: number; code: string; message: string }
export function humanActionRefusal(op: WalnutOp, origin: string, confirmed: boolean): HumanActionRefusal | undefined {
  if (op.name === 'api') return { status: 400, code: 'not_invocable', message: 'api cannot be invoked from a human action' };
  if ((op.tags.localHostGateway || op.tags.remote === 'deny') && origin !== LOCAL_ORIGIN) {
    return { status: 403, code: 'local_only', message: op.tags.localHostGateway
      ? `${op.name} refused: ${op.localOnlyMessage ?? HEALTH_LOCAL_ONLY_MESSAGE}`
      : `${op.name} runs only from the console on this Mac` };
  }
  if (!confirmed && (op.tags.destructive || DESTRUCTIVE.has(op.name) || POWERFUL.has(op.name))) {
    return { status: 400, code: 'confirmation_required', message: `${op.name} requires confirmation before running it` };
  }
  return undefined;
}
/** Never trust Host or fall back to the production port for an in-server execution. */
export function humanActionApiBase(req?: Request): string {
  const root = getSelfApiRoot();
  if (root) return root;
  const port = req?.socket.localPort;
  if (!Number.isInteger(port) || !port || port <= 0) throw new Error('The listening server address is unavailable');
  return `http://127.0.0.1:${port}`;
}
