/**
 * Built-in actions the host imports as its OWN modules.
 *
 * They used to be separate build entries (`dist/actions/<id>.js`, no code
 * splitting), so each was a self-contained bundle with a private copy of every
 * core module it pulled in. Discovery imports every built-in at boot to read its
 * descriptor, so the server always carried the triage action's 14.8 MB bundle:
 * about 30 MB of source text in the heap, compiled code for a second copy of
 * core, and module state (config cache, triage state) that was not the host's.
 * Importing through this table puts the action code in the host bundle, the same
 * fix `src/integrations/host-modules.ts` made for built-in plugins.
 * `tests/core/builtin-action-modules.test.ts` pins one row per action file.
 */
export const BUILTIN_ACTION_MODULES: Readonly<Record<string, () => Promise<Record<string, unknown>>>> = {
  'inbox-triage-batch': () => import('./inbox-triage-batch.js'),
  'screenshot-track': () => import('./screenshot-track.js'),
};
