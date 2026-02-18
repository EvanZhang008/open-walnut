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
}

/** Internal type — descriptor enriched with source and file path. */
export interface ActionDefinition extends ActionDescriptor {
  source: 'builtin' | 'user';
  filePath: string;
}
