/**
 * Cron Action Registry — lightweight registered functions that run inline
 * (no agent loop), optionally piping output to a target agent.
 *
 * Actions are the "data collection" step; agents are the "analysis" step.
 */

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

const registry = new Map<string, ActionRegistration>();

/**
 * Register a named action.
 */
export function registerAction(id: string, fn: ActionFn, description: string): void {
  registry.set(id, { fn, description });
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
  return Array.from(registry.entries()).map(([id, reg]) => ({
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
