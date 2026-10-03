/**
 * Retention for the stall flight recorder's directory (stall-recorder.ts): kept
 * profiles and their meta live and die together, newest first, bounded by
 * count, age and total size; temp files a dead writer left behind go too.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';

export interface StallRetention {
  maxFiles: number;
  maxAgeMs: number;
  maxBytes: number;
}

/** `.tmp-<pid>-stall-...`: a write in flight (writeWhole), or one a crash left behind. */
const TMP_NAME = /^\.tmp-(\d+)-stall-/;
/** A write takes milliseconds; a temp file this old is no write in flight, whoever made it. */
const TMP_STALE_MS = 10 * 60_000;

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM'; }
}

/**
 * Remove a temp file whose writer is gone. writeWhole cleans up its own temp
 * on a failed write, but a process that dies between the write and the rename
 * (a crash, a SIGKILL, a power cut) leaves it, and nothing else ever looks at
 * names outside the `stall-` namespace: they would pile up without a bound.
 */
async function sweepTemp(dir: string, name: string, pid: number): Promise<void> {
  const file = path.join(dir, name);
  let mtime: number;
  try { mtime = (await fsp.stat(file)).mtimeMs; } catch { return; }
  const writerGone = pid !== process.pid && !pidAlive(pid);
  if (!writerGone && Date.now() - mtime <= TMP_STALE_MS) return;
  try { await fsp.unlink(file); } catch { /* raced */ }
}

export async function pruneStallDir(dir: string, limits: StallRetention): Promise<void> {
  let names: string[];
  try { names = await fsp.readdir(dir); } catch { return; }
  const rows: { name: string; mtime: number; size: number }[] = [];
  for (const name of names) {
    const tmp = TMP_NAME.exec(name);
    if (tmp) { await sweepTemp(dir, name, Number(tmp[1])); continue; }
    if (!name.startsWith('stall-')) continue;
    try {
      const st = await fsp.stat(path.join(dir, name));
      rows.push({ name, mtime: st.mtimeMs, size: st.size });
    } catch { /* raced */ }
  }
  // Group a profile with its meta by base name so they live and die together.
  const groups = new Map<string, { mtime: number; size: number; names: string[] }>();
  for (const r of rows) {
    const base = r.name.replace(/\.(cpuprofile|json)$/, '');
    const g = groups.get(base) ?? { mtime: 0, size: 0, names: [] };
    g.mtime = Math.max(g.mtime, r.mtime); g.size += r.size; g.names.push(r.name);
    groups.set(base, g);
  }
  const sorted = [...groups.values()].sort((a, b) => b.mtime - a.mtime);
  const now = Date.now();
  let bytes = 0;
  for (let i = 0; i < sorted.length; i++) {
    const g = sorted[i];
    bytes += g.size;
    if (i < limits.maxFiles && now - g.mtime <= limits.maxAgeMs && bytes <= limits.maxBytes) continue;
    // The .json goes first, so a record that is listed is never half deleted.
    const order = [...g.names].sort((x, y) => Number(y.endsWith('.json')) - Number(x.endsWith('.json')));
    for (const n of order) { try { await fsp.unlink(path.join(dir, n)); } catch { /* gone */ } }
  }
}
