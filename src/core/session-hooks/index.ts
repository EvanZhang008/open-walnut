/**
 * Session Lifecycle Hooks — barrel exports + singleton.
 */

export { SessionHookDispatcher } from './dispatcher.js';
export { builtinHooks } from './builtins.js';
export { discoverFileHooks } from './discovery.js';
export type {
  SessionHookPoint,
  SessionHookContext,
  SessionHookDefinition,
  SessionHookFilter,
  SessionHooksConfig,
  OnSessionStartPayload,
  OnMessageSendPayload,
  OnTurnStartPayload,
  OnToolUsePayload,
  OnToolResultPayload,
  OnPlanCompletePayload,
  OnModeChangePayload,
  OnTurnCompletePayload,
  OnTurnErrorPayload,
  OnSessionEndPayload,
  OnSessionIdlePayload,
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
