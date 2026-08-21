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

export function setSessionHookDispatcher(d: SessionHookDispatcher | null): void {
  dispatcher = d;
}
