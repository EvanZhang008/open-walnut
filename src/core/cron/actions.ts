/**
 * Cron Action Registry — lightweight registered functions that run inline
 * (no agent loop), optionally piping output to a target agent.
 *
 * Actions are the "data collection" step; agents are the "analysis" step.
 */

import { OwnedRegistry } from '../plugins/owned-registry.js';
import type { Disposable } from '../plugins/disposable.js';

export interface ActionResult {
  status: 'ok' | 'error';
  summary?: string;
  error?: string;
  data?: unknown; // structured data passed to target agent
}

export type ActionFn = (params: Record<string, unknown>) => Promise<ActionResult>;

interface ActionRegistration {
  fn: ActionFn;
  description: string;
}

const registry = new OwnedRegistry<ActionRegistration>();

/** Register a core action. Existing callers may ignore the returned handle. */
export function registerAction(id: string, fn: ActionFn, description: string): Disposable {
  return registry.replace('core', id, { fn, description });
}

export function registerOwnedAction(
  owner: string,
  id: string,
  fn: ActionFn,
  description: string,
): Disposable {
  return registry.register(owner, id, { fn, description });
}

export function unregisterOwnedActions(owner: string): number {
  return registry.removeOwner(owner);
}

/**
 * Look up an action by ID.
 */
export function getAction(id: string): ActionRegistration | undefined {
  return registry.get(id);
}

/**
 * List all registered actions (for frontend dropdowns).
 */
export function listActions(): Array<{ id: string; description: string }> {
  return registry.entries().map(({ key: id, value: reg }) => ({
    id,
    description: reg.description,
  }));
}

/**
 * Run a registered action by ID with given params.
 */
export async function runAction(
  id: string,
  params: Record<string, unknown>,
): Promise<ActionResult> {
  const registration = registry.get(id);
  if (!registration) {
    return { status: 'error', error: `Action "${id}" not found` };
  }
  try {
    return await registration.fn(params);
  } catch (err) {
    return {
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function _resetActionsForTesting(): void {
  registry.clear();
}
