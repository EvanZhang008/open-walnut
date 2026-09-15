/**
 * How the embedded Python daemons (ASR in engine-mlx.ts, cleanup in
 * cleanup-mlx.ts) receive their source: over stdin, as `python -`.
 *
 * There is deliberately no file. The first shape wrote server.py into one
 * mkdtemp dir per server lifetime and reused that path on every daemon
 * restart; a disk-cleanup pass removed the dir mid-day (2026-09-15, it looked
 * like any other leaked walnut-* temp entry) and every dictation after that
 * failed with ENOENT until the server was restarted. macOS also prunes tmp
 * entries untouched for 3 days, so any remembered path goes stale on a
 * long-lived server. A per-start file only narrows that to the spawn-to-open
 * window and adds a dir to dispose; stdin removes the dependency: nothing to
 * sweep, nothing to leak, nothing for `ps` to name that no longer exists. Both
 * scripts read only sys.argv[1..3], which `-` leaves in place (argv[0] is "-").
 */

import type { ChildProcess } from 'node:child_process';

/** The argv[0] that makes python read the program from stdin. */
export const PYTHON_STDIN_SCRIPT = '-';

/**
 * Python source prologue for a program fed over stdin. CPython sets
 * `__main__.__file__` to the literal "<stdin>", and multiprocessing's spawn
 * start method (the macOS default) would hand that to runpy in every worker
 * and die on `<cwd>/<stdin>`; with no `__file__` at all it skips re-running
 * main, which is right for a server. None of the current model stack forks
 * workers, this keeps that true by construction rather than by audit.
 */
export const STDIN_MAIN_PROLOGUE = `
import sys
if getattr(sys.modules["__main__"], "__file__", None) == "<stdin>":
    del sys.modules["__main__"].__file__
`;

export function feedDaemonSource(proc: ChildProcess, source: string): void {
  const stdin = proc.stdin;
  if (!stdin) throw new Error('daemon spawned without a stdin pipe');
  // EPIPE here means the child died before reading; its exit is what the
  // caller reports, so the write error itself is noise.
  stdin.on('error', () => {});
  stdin.end(STDIN_MAIN_PROLOGUE + source);
}
