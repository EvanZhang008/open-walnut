/**
 * Read-only process identity for E2E cleanup checks: `ps` start time and full
 * command line of one pid. "Gone" is proven, never assumed: a pid is gone only
 * when ps answers normally that it does not exist, or shows a different start
 * time (the pid was reused). A ps that fails any other way is unknown, and the
 * caller's cleanup fails.
 */
import { execFileSync } from 'node:child_process';
import { guardedPath } from '../../setup/exec-guard.js';

export type Identity = { state: 'present'; lstart: string; command: string } | { state: 'absent' };
type Run = (pid: number) => string;

// The C locale fixes lstart's shape whatever the runner's locale is.
const runPs: Run = pid => execFileSync('/bin/ps', ['-ww', '-o', 'lstart=', '-o', 'command=', '-p', String(pid)],
  { encoding: 'utf8', timeout: 5_000, env: { PATH: guardedPath([], '/usr/bin:/bin'), LC_ALL: 'C', LANG: 'C' } });

export function processIdentity(pid: number, run: Run = runPs): Identity {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error(`not a process id: ${pid}`);
  let out: string;
  try { out = run(pid); }
  catch (error) {
    const e = error as { status?: number | null; stdout?: unknown; signal?: string | null };
    // ps exits 1 with nothing on stdout for a pid that does not exist.
    if (e.status === 1 && !e.signal && !String(e.stdout ?? '').trim()) return { state: 'absent' };
    throw new Error(`ps could not tell whether ${pid} runs: ${(error as Error).message}`);
  }
  const line = out.trim();
  // ps reports a missing pid by exiting 1; a successful run that names nothing proves nothing.
  if (!line) throw new Error(`ps could not tell whether ${pid} runs: it succeeded with no output`);
  // lstart is a fixed 24 characters ("Fri Oct 24 01:23:45 2026").
  if (!/^\w{3} \w{3} [ \d]\d \d\d:\d\d:\d\d \d{4}/.test(line)) throw new Error(`ps answered something unexpected for ${pid}: ${line.slice(0, 80)}`);
  return { state: 'present', lstart: line.slice(0, 24), command: line.slice(24).trim() };
}

/** The process seen earlier no longer runs (absent, or its pid now belongs to a later process). Throws when unknown. */
export function processGone(seen: { pid: number; lstart: string }, run: Run = runPs): boolean {
  const now = processIdentity(seen.pid, run);
  return now.state === 'absent' || now.lstart !== seen.lstart;
}
