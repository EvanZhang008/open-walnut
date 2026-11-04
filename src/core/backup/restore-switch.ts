/**
 * "Use this restored data": the restored folder becomes the data folder.
 *
 * The data folder cannot be swapped under a running Walnut (open databases,
 * open logs). So the switch is asked for while Walnut runs (a small marker file
 * beside the data folder, never inside it) and done when the server starts,
 * before anything reads the data folder: the current folder is renamed aside
 * (kept, never deleted), then the restored one is renamed into its place.
 *
 * Each step is a rename on one disk, and a start that died between the two
 * finishes the switch, or puts the old folder back, on the next start. This
 * machine's writer id (local/backup/machine-id, never backed up) moves with
 * the switch: it is the same computer, so it stays the writer of its backups.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { machineIdPath } from './local-state.js';

export interface PendingSwitch {
  /** The restored folder (absolute). */
  restored: string;
  /** Where the current data folder goes (absolute, beside it). */
  aside: string;
  at: string;
}

export type SwitchOutcome =
  | { kind: 'none' }
  | { kind: 'switched'; aside: string }
  | { kind: 'failed'; error: string };

export const switchMarkerPath = (home: string): string => `${path.resolve(home)}.restore-switch.json`;
export const switchErrorPath = (home: string): string => `${path.resolve(home)}.restore-switch-error.txt`;

const exists = (p: string): Promise<boolean> => fs.stat(p).then(() => true, () => false);

/** The aside name: beside the data folder, to the second, never one that exists. */
export async function asideFor(home: string, now = new Date()): Promise<string> {
  const base = `${path.resolve(home)}-before-restore-${now.toISOString().slice(0, 19).replace(/:/g, '-')}`;
  let p = base;
  for (let n = 2; await exists(p); n++) p = `${base}-${n}`;
  return p;
}

/** Ask for the switch at the next start. The checks a start repeats are made now too, so the user hears them at once. */
export async function requestSwitch(home: string, restored: string, now = new Date()): Promise<PendingSwitch> {
  const h = path.resolve(home);
  const r = path.resolve(restored);
  if (r === h || r.startsWith(h + path.sep) || h.startsWith(r + path.sep)) throw new Error('The restored folder must be apart from the data folder.');
  const st = await fs.stat(r).catch(() => null);
  if (!st?.isDirectory()) throw new Error(`${r} is not there any more. Restore again.`);
  if ((await fs.readdir(r)).length === 0) throw new Error(`${r} is empty. Restore again.`);
  const pending: PendingSwitch = { restored: r, aside: await asideFor(h, now), at: now.toISOString() };
  const marker = switchMarkerPath(h);
  const tmp = `${marker}.tmp-${process.pid}`;
  await fs.writeFile(tmp, `${JSON.stringify(pending, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tmp, marker);
  await fs.rm(switchErrorPath(h), { force: true });
  return pending;
}

export async function readPendingSwitch(home: string): Promise<PendingSwitch | null> {
  try {
    const p = JSON.parse(await fs.readFile(switchMarkerPath(home), 'utf8')) as Partial<PendingSwitch>;
    if (typeof p.restored !== 'string' || typeof p.aside !== 'string' || !path.isAbsolute(p.restored) || !path.isAbsolute(p.aside)) return null;
    return { restored: p.restored, aside: p.aside, at: String(p.at ?? '') };
  } catch {
    return null;
  }
}

export async function cancelSwitch(home: string): Promise<void> {
  await fs.rm(switchMarkerPath(home), { force: true });
}

/** The last start's failed switch, in words, or null. */
export async function lastSwitchError(home: string): Promise<string | null> {
  return fs.readFile(switchErrorPath(home), 'utf8').then((t) => t.trim() || null, () => null);
}

async function carryMachineId(from: string, to: string): Promise<void> {
  const src = machineIdPath(from);
  const dst = machineIdPath(to);
  if (await exists(dst)) return;
  const id = await fs.readFile(src, 'utf8').catch(() => null);
  if (id === null) return;
  await fs.mkdir(path.dirname(dst), { recursive: true, mode: 0o700 });
  await fs.writeFile(dst, id, { mode: 0o600 });
}

/**
 * At server start, before the data folder is read: do a switch that was asked
 * for. Never throws; a switch that cannot be done leaves the data folder as it
 * was (or puts it back), drops the request, and says why in a file beside it.
 */
export async function applyPendingSwitch(home: string, ops: Pick<typeof fs, 'rename'> = fs): Promise<SwitchOutcome> {
  const h = path.resolve(home);
  const p = await readPendingSwitch(h);
  if (!p) {
    await fs.rm(switchMarkerPath(h), { force: true }).catch(() => {});
    return { kind: 'none' };
  }
  const fail = async (error: string): Promise<SwitchOutcome> => {
    await fs.writeFile(switchErrorPath(h), `${new Date().toISOString()} ${error}\n`).catch(() => {});
    await fs.rm(switchMarkerPath(h), { force: true }).catch(() => {});
    return { kind: 'failed', error };
  };
  const [hasHome, hasRestored, hasAside] = await Promise.all([exists(h), exists(p.restored), exists(p.aside)]);
  try {
    if (hasHome && hasRestored && !hasAside) {
      await ops.rename(h, p.aside);
      try {
        await ops.rename(p.restored, h);
      } catch (err) {
        await ops.rename(p.aside, h); // put the old folder back
        throw err;
      }
    } else if (!hasHome && hasRestored && hasAside) {
      await ops.rename(p.restored, h); // a start that died between the two renames
    } else if (!hasHome && !hasRestored && hasAside) {
      await ops.rename(p.aside, h); // the restored folder is gone: the old one comes back
      return fail(`The restored folder ${p.restored} was gone; Walnut kept its data folder.`);
    } else if (hasHome && !hasRestored && hasAside) {
      // Done before the marker went.
    } else {
      return fail(hasAside
        ? `${p.aside} already exists; Walnut kept its data folder.`
        : `The restored folder ${p.restored} was gone; Walnut kept its data folder.`);
    }
  } catch (err) {
    return fail(`The switch failed (${err instanceof Error ? err.message : String(err)}); Walnut kept its data folder.`);
  }
  await carryMachineId(p.aside, h).catch(() => {});
  await fs.rm(switchMarkerPath(h), { force: true }).catch(() => {});
  return { kind: 'switched', aside: p.aside };
}
