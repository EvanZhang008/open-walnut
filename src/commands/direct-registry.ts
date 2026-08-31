/**
 * Direct-mode runner registry — the seam that keeps WALNUT_CLI_DIRECT support
 * out of the fast CLI bundle.
 *
 * Why a registry instead of `await import('./direct-commands.js')` inside each
 * command: the bundler inlines every LITERAL dynamic import it can see, whether
 * or not it ever runs. One mention of the direct module inside a data command
 * would drag core/task-manager (sqlite, logging, the works) into the slim
 * dist/cli-fast.js and re-inflate every call from ~0.15s back to ~0.6s. So the
 * data commands only know this tiny registry; the ONLY file that names the
 * direct module is src/cli.ts (the full entry), which installs the runners
 * when WALNUT_CLI_DIRECT=1.
 *
 * The bin router sends WALNUT_CLI_DIRECT=1 invocations to the full entry, so
 * under normal operation a data command never sees the env flag without the
 * runners installed. Direct src imports (tests) must install explicitly —
 * failing loud here protects test isolation: silently falling through to HTTP
 * would write into the developer's production store on :3456.
 */

import type { GlobalOptions } from '../core/types.js';

export interface DirectRunners {
  add(title: string, options: { priority?: string; list?: string; project?: string; due?: string }, globals: GlobalOptions): Promise<void>;
  tasks(options: { status?: string; project?: string }, globals: GlobalOptions): Promise<void>;
  done(id: string, globals: GlobalOptions): Promise<void>;
  recall(query: string, globals: GlobalOptions): Promise<void>;
  projects(globals: GlobalOptions): Promise<void>;
  sessions(globals: GlobalOptions): Promise<void>;
  start(taskIdPrefix: string, options: { message?: string }, globals: GlobalOptions): Promise<void>;
}

let runners: DirectRunners | null = null;

export function installDirectRunners(r: DirectRunners): void {
  runners = r;
}

/**
 * The installed direct runners, or a loud failure when WALNUT_CLI_DIRECT=1 is
 * set in a process that never installed them (see module comment).
 */
export function requireDirectRunners(): DirectRunners {
  if (!runners) {
    throw new Error(
      'WALNUT_CLI_DIRECT=1 requires the full CLI entry (dist/cli.js), which installs the direct runners. '
      + 'In tests, import ./direct-commands.js and call install() first.',
    );
  }
  return runners;
}
