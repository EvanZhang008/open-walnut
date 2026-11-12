/**
 * While this server runs an engine switch (a task move above all), a marker per task says so, so
 * a deploy waits for it (2026-11-12: a move to a remote host uploads at about 20 KB/s and takes 10 to
 * 15 minutes, deploys came every 10 to 20 minutes, and a move started 12:14:51Z was cut at 12:27:02Z
 * by the next one). The deploy queue reads them (scripts/lib/deploy-queue.sh, dq_moving):
 *
 *   WALNUT_HOME/local/running-switches/<task id>   "<server pid> <start epoch s> <task id> <run token> <what>"
 *
 * Written when the switch's work starts and removed when it settles, however it settles, by the
 * run that wrote it only (a later run of the same task writes its own token over it). A marker
 * of a pid no longer alive, or older than the queue's hold, holds nothing; a boot removes the ones
 * an earlier server left (a forced deploy, a crash). local/ is never git-synced.
 */
import { randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { WALNUT_HOME } from '../../constants.js';
import { log } from '../../logging/index.js';

export function runningSwitchesDir(home = WALNUT_HOME): string {
  return path.join(home, 'local', 'running-switches');
}

/** A task id as a file name: only the characters a task id has. */
function fileOf(taskId: string, home: string): string | null {
  return /^[A-Za-z0-9._-]{1,96}$/.test(taskId) ? path.join(runningSwitchesDir(home), taskId) : null;
}

/** Each run's write, by its token. */
const marking = new Map<string, Promise<void>>();

/**
 * This server runs `taskId`'s switch now; answers the run's token for clearSwitchRunning. Never
 * throws: a marker that cannot be written only costs the deploy hold.
 */
export function markSwitchRunning(taskId: string, what: string, home = WALNUT_HOME): string {
  const token = randomBytes(6).toString('hex');
  const file = fileOf(taskId, home);
  if (!file) return token;
  const line = `${process.pid} ${Math.floor(Date.now() / 1000)} ${taskId} ${token} ${what.replace(/\s+/g, ' ').slice(0, 120)}\n`;
  const write = (async () => {
    await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${token}.tmp`;
    await fsp.writeFile(tmp, line, { mode: 0o600 });
    await fsp.rename(tmp, file);
  })().catch((err: unknown) => log.session.warn('engine switch: the running marker was not written; a deploy will not wait for it', {
    taskId, error: err instanceof Error ? err.message : String(err),
  }));
  marking.set(token, write);
  return token;
}

/** The run settled: its marker goes, once its write is done (a fast switch never leaves one behind), and only while it is this run's. */
export async function clearSwitchRunning(taskId: string, token: string, home = WALNUT_HOME): Promise<void> {
  const file = fileOf(taskId, home);
  await marking.get(token);
  marking.delete(token);
  if (!file) return;
  try {
    const [pid, , , own] = (await fsp.readFile(file, 'utf8')).split(' ');
    if (Number(pid) === process.pid && own === token) await fsp.rm(file, { force: true });
  } catch { /* none */ }
}

/** At boot: markers an earlier server left (its switches end with it). Returns how many went. */
export async function sweepRunningSwitchMarkers(home = WALNUT_HOME): Promise<number> {
  let names: string[];
  try { names = await fsp.readdir(runningSwitchesDir(home)); } catch { return 0; }
  let n = 0;
  for (const name of names) {
    const file = path.join(runningSwitchesDir(home), name);
    const pid = Number((await fsp.readFile(file, 'utf8').catch(() => '')).split(' ')[0]);
    if (pid !== process.pid || name.endsWith('.tmp')) { await fsp.rm(file, { force: true }).catch(() => {}); n++; }
  }
  return n;
}
