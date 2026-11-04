/**
 * Session Lifecycle Hooks — barrel exports + singleton.
 */

export { SessionHookDispatcher, HookDispatcher } from './dispatcher.js';
export { builtinHooks } from './builtins.js';
export { discoverFileHooks } from './discovery.js';
export { HOOK_POINT_DOMAIN } from './types.js';
export type {
  SessionHookPoint,
  TaskHookPoint,
  CronHookPoint,
  HookPoint,
  HookDomain,
  SessionHookContext,
  TaskHookContext,
  HookContext,
  SessionHookDefinition,
  HookDefinition,
  SessionHookFilter,
  HookFilter,
  HookActionRef,
  SessionHooksConfig,
  OnCronFiredPayload,
  OnSessionStartPayload,
  OnMessageSendPayload,
  OnTurnStartPayload,
  OnToolUsePayload,
  OnToolResultPayload,
  OnPlanCompletePayload,
  OnModeChangePayload,
  OnTurnCompletePayload,
  OnTurnErrorPayload,
} from './types.js';

import { SessionHookDispatcher } from './dispatcher.js';

/** Module-level singleton — initialized in startServer(). */
let dispatcher: SessionHookDispatcher | null = null;

export function getSessionHookDispatcher(): SessionHookDispatcher | null {
  return dispatcher;
}

export function setSessionHookDispatcher(d: SessionHookDispatcher | null, reload?: () => Promise<void>): void {
  dispatcher = d;
  reloadFromConfig = d ? reload ?? null : null;
}

let reloadFromConfig: (() => Promise<void>) | null = null;

/** Rebuild the dispatcher's hooks from the config on disk now, and resolve once they are in.
 *  config:changed also reloads it, but a listener the bus calls without waiting: a writer that
 *  answers with the hook list (PATCH /api/hooks) awaits this, or the list it reads can miss a
 *  hook it just turned back on. */
export async function reloadSessionHooks(): Promise<void> {
  await reloadFromConfig?.();
}
