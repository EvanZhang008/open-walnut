/**
 * Modules a Node build of Walnut reads as separate dist files, carried inside
 * the compiled file instead.
 *
 * A Node build starts them as programs (`node <dist file>`, or forks `<dist file>`).
 * In the compiled file,
 * process.execPath is the file, so a program arrives as
 * `walnut <runtime root>/<dist file> ...` and src/binary/main.ts evaluates the
 * bundled module; an import by path asks `bundledModule()` (src/lib/single-file.ts)
 * first. The runtime tree holds a placeholder at each path
 * (scripts/build-binary.mjs), so the existence checks and directory scans the
 * callers already make keep working.
 *
 * Keys are paths relative to the runtime root. tests/binary/bundled-modules.test.ts
 * pins that every row's module exists. The built-in actions are not here: the
 * host bundle imports them (src/actions/builtin-modules.ts), so they are in the
 * file as ordinary modules.
 */
export const BUNDLED_MODULES: Readonly<Record<string, () => Promise<Record<string, unknown>>>> = {
  // Forked by src/web/server.ts (daily history compaction).
  'dist/workers/git-compaction-worker.js': () => import('../workers/git-compaction-worker.js'),
  // Forked by the hybrid search embedder (src/core/search/wiring.ts finds this path).
  'dist/lib/hybrid-search/embed-worker.js': () => import('../lib/hybrid-search/embed-worker.js'),
  // Spawned by the ACP session path (src/providers/acp-session.ts) through the daemon.
  'dist/daemon-binaries/acp-worker.js': () => import('../providers/acp-worker/worker-main.js'),
  // Claude Code stop and compact hooks.
  'dist/hooks/on-stop.js': () => import('../hooks/on-stop.js'),
  'dist/hooks/on-compact.js': () => import('../hooks/on-compact.js'),
}

/** The placeholder written at each of those paths in the runtime tree. */
export const MODULE_PLACEHOLDER =
  "throw new Error('This file stands for a module inside the compiled walnut file: run it with that file, not with node.')\n"
