/**
 * The task mention shape lives in src/lib/task-id-shape.ts so the server (the
 * letter body linker, src/lib/agent-text-refs.ts) and the browser read ONE rule.
 * Relative import on purpose, like path-ref-parse in markdown.ts: the markdown
 * test tier runs in a bare node env, and the shared module has no imports.
 */
export * from '../../../src/lib/task-id-shape';
