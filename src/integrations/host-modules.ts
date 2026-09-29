/**
 * Built-in plugins the host imports as its OWN modules.
 *
 * The build emits every `src/integrations/<id>/index.ts` as a self-contained
 * bundle (`dist/integrations/<id>/index.js`, no code splitting), so importing
 * that file gives the plugin a private copy of everything it pulled from
 * `src/core`: its own task store cache and SQLite connection, its own event bus,
 * its own config manager. On the live server the ms-todo copy saw every host
 * write as a foreign commit and rescanned all 6.5k tasks each time, the single
 * largest event-loop hog measured on 2026-09-29 (22% of main-thread CPU).
 *
 * Importing through this table instead lands the plugin code inside the host
 * bundle, so it shares the host's module instances. The dist file still exists
 * for its manifest, icon and web entry. Every built-in directory must have a
 * row here; `tests/core/builtin-host-modules.test.ts` pins that.
 */
export const BUILTIN_HOST_MODULES: Readonly<Record<string, () => Promise<Record<string, unknown>>>> = {
  calendar: () => import('./calendar/index.js'),
  jira: () => import('./jira/index.js'),
  local: () => import('./local/index.js'),
  mail: () => import('./mail/index.js'),
  'mail-imap': () => import('./mail-imap/index.js'),
  'ms-todo': () => import('./ms-todo/index.js'),
};
