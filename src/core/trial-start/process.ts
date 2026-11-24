/**
 * Starting and stopping a Walnut server as a child process, shared by the leader switch's
 * trial and commit starts (src/core/leader/switch/side.ts) and the restore drill's trial boot
 * (src/core/backup/restore-drill-boot.ts).
 */
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { singleFile } from '../../lib/single-file.js';

export function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM'; }
}

/**
 * What tells this process from a later one that got its pid (after a reboot, or pids wrapping): on Linux the boot id
 * and the process's start time in clock ticks since boot (/proc/<pid>/stat field 22); elsewhere (macOS) the boot
 * time and the start time `ps` gives. Null when it cannot be read (the process is gone, or no way to ask).
 */
export async function processStartMark(pid: number): Promise<string | null> {
  if (!Number.isInteger(pid) || pid <= 1) return null;
  try {
    if (process.platform === 'linux') {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      // The command name (field 2) may hold spaces and parentheses: the fields after its last ')' are plain.
      const start = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
      const boot = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
      return start ? `${boot}:${start}` : null;
    }
    const run = promisify(execFile);
    const start = (await run('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 5_000 })).stdout.trim();
    const boot = (await run('sysctl', ['-n', 'kern.boottime'], { encoding: 'utf8', timeout: 5_000 })).stdout.trim();
    return start ? `${boot}|${start}` : null;
  } catch {
    return null;
  }
}

/** The process `p` names is still the one that was there when `p.start` was read (processStartMark): same pid, same start. */
export async function sameProcess(p: { pid: number; start: string | null }): Promise<boolean> {
  if (!alive(p.pid)) return false;
  const now = await processStartMark(p.pid);
  return p.start !== null && now !== null && now === p.start;
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
