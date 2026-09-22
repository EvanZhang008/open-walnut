/**
 * Action module types — file-based action discovery system.
 *
 * Each action is a .ts (built-in) or .mjs (user) module that exports
 * `describe()` and `run()` functions conforming to these interfaces.
 */

export interface ActionDescriptor {
  id: string;
  name: string;
  description: string;
  platform?: NodeJS.Platform; // omit = all platforms
}

export interface ActionContext {
  WALNUT_HOME: string;
  params: Record<string, unknown>;
}

export interface ActionResult {
  invoke: boolean;
  content?: string;
  image?: { base64: string; mediaType: string };
  /**
   * How the RUN should be recorded when this action is a routine's init processor.
   *
   * Omitted (the default) means "ok": `invoke:false` then simply hands `content`
   * to the agent as text, which is what a screenshot action's "screen unchanged"
   * does. `'skipped'` is stronger — it REFUSES the fire, so the executor never
   * runs and no session is minted (an init processor is the only place that can
   * decline before that happens; Inbox Triage's active-hours window is the first
   * user). `'error'` fails the run and engages the engine's error backoff.
   *
   * Only meaningful for the init-processor path; the agent-facing surfaces read
   * `invoke`/`content` and ignore this.
   */
  status?: 'skipped' | 'error';
}

/** Internal type — descriptor enriched with source and file path. */
export interface ActionDefinition extends ActionDescriptor {
  source: 'builtin' | 'user';
  filePath: string;
}
