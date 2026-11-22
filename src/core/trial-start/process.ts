/**
 * Starting and stopping a Walnut server as a child process, shared by the leader switch's
 * trial and commit starts (src/core/leader/switch/side.ts) and the restore drill's trial boot
 * (src/core/backup/restore-drill-boot.ts).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { singleFile } from '../../lib/single-file.js';

export function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM'; }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** SIGTERM, SIGKILL after `graceMs`; resolves once the process is gone. Never a pid <= 1. */
export async function stopPid(pid: number, graceMs: number): Promise<{ killed: boolean }> {
  if (!alive(pid)) return { killed: false };
  try { process.kill(pid, 'SIGTERM'); } catch { /* gone already */ }
  const deadline = Date.now() + graceMs;
  while (alive(pid) && Date.now() < deadline) await sleep(100);
  if (!alive(pid)) return { killed: false };
  try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
  while (alive(pid)) await sleep(50);
  return { killed: true };
}

/** The CLI entry of this Walnut: src/cli.ts in a checkout, the bundle's own in dist. */
export function defaultCli(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // src/core/trial-start/process.ts -> src/cli.ts; dist/... bundles resolve their own entry.
  for (const c of [path.resolve(here, '../../cli.ts'), path.resolve(here, '../../cli.js'), path.resolve(here, 'cli.js')]) {
    if (fs.existsSync(c)) return c;
  }
  return process.argv[1];
}

/** The command that runs this Walnut's CLI with `args`: the compiled file runs itself. */
export function serverCommand(args: string[]): string[] {
  return singleFile() ? [process.execPath, ...args] : [process.execPath, defaultCli(), ...args];
}

/** The last `bytes` of a log file, '' when there is none. */
export function tail(file: string, bytes = 4_000): string {
  try {
    const b = fs.readFileSync(file);
    return b.subarray(Math.max(0, b.length - bytes)).toString('utf8');
  } catch {
    return '';
  }
}
