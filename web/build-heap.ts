import { spawnSync } from 'node:child_process';
import v8 from 'node:v8';

/**
 * Room for the production build's heap, wherever `vite build` is started from.
 *
 * Rollup keeps every module's syntax tree for the whole build (bundle-trim.ts), and the build
 * needed about 1.85 GB of a 2 GB heap: Node's default on a 7 GB machine such as a macOS CI runner
 * or a small laptop (2026-11-16: two Nightly extra tests jobs ran out of memory). The build is run
 * from a dozen places (package.json scripts, workflows, deploy scripts), so the heap is set here,
 * where all of them pass: a Node build with less than BUILD_HEAP_MB runs itself again with it.
 * Bun has no such cap and is left alone. Guard: tests/web/build-heap.test.ts.
 */
export const BUILD_HEAP_MB = 4096;
/** Set in the rerun so it never runs itself again. */
export const BUILD_HEAP_ENV = 'WALNUT_VITE_BUILD_HEAP';

export interface HeapRerun { args: string[]; env: NodeJS.ProcessEnv }

/** The rerun a build needs, or null: only `vite build` under Node, below the heap, not already rerun. */
export function buildHeapRerun(
  argv: readonly string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
  heapLimitBytes: number = v8.getHeapStatistics().heap_size_limit,
  onBun: boolean = Boolean(process.versions.bun),
): HeapRerun | null {
  if (onBun || env[BUILD_HEAP_ENV] === '1' || !argv.slice(2).includes('build')) return null;
  if (heapLimitBytes >= BUILD_HEAP_MB * 1024 * 1024 * 0.95) return null;
  return {
    args: [`--max-old-space-size=${BUILD_HEAP_MB}`, ...argv.slice(1)],
    env: { ...env, [BUILD_HEAP_ENV]: '1' },
  };
}

/** Runs the build again with BUILD_HEAP_MB and exits with its status, when this one has less. */
export function ensureBuildHeap(): void {
  const rerun = buildHeapRerun();
  if (!rerun) return;
  console.log(`vite build: rerunning with a ${BUILD_HEAP_MB} MB heap (this Node gives ${Math.round(v8.getHeapStatistics().heap_size_limit / 1024 / 1024)} MB)`);
  const result = spawnSync(process.execPath, rerun.args, { stdio: 'inherit', env: rerun.env });
  process.exit(result.status ?? 1);
}
