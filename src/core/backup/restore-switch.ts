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
import { pidAlive, processStart } from '../self-update/install-lock.js';

export interface PendingSwitch {
  /** The restored folder (absolute). */
  restored: string;
  /** Where the current data folder goes (absolute, beside it). */
  aside: string;
  at: string;
  /** The server that asked: the switch waits until it is gone (it still has the folder open). */
  pid?: number;
  started?: string;
}

export type SwitchOutcome =
  | { kind: 'none' }
  /** The server that asked still runs (another start beside it): nothing moved, the request stays. */
  | { kind: 'waiting' }
  | { kind: 'switched'; aside: string }
  /** `fatal`: the data folder is not in place; the server must not start on an empty one. */
  | { kind: 'failed'; error: string; fatal?: boolean };

/** A request older than this is dropped, not done: days of work since would go aside. */
export const SWITCH_MAX_AGE_MS = 24 * 3_600_000;

export interface SwitchDeps {
  rename?: (a: string, b: string) => Promise<void>;
  alive?: (pid: number) => boolean;
  started?: (pid: number) => Promise<string>;
  now?: () => number;
}

export const switchMarkerPath = (home: string): string => `${path.resolve(home)}.restore-switch.json`;
export const switchErrorPath = (home: string): string => `${path.resolve(home)}.restore-switch-error.txt`;
/** The last switch done: where the previous data went, so the pane can say it once. */
export const switchDonePath = (home: string): string => `${path.resolve(home)}.restore-switch-done.json`;

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
  const st = await fs.stat(r).catch(() => null);
  if (!st?.isDirectory()) throw new Error(`${r} is not there any more. Restore again.`);
  if ((await fs.readdir(r)).length === 0) throw new Error(`${r} is empty. Restore again.`);
  // Compared as the disk has them: a link must not hide one inside the other.
  const [realH, realR] = await Promise.all([fs.realpath(h), fs.realpath(r)]);
  if (realR === realH || realR.startsWith(realH + path.sep) || realH.startsWith(realR + path.sep)) throw new Error('The restored folder must be apart from the data folder.');
  if ((await fs.lstat(h)).isSymbolicLink()) throw new Error(`${h} is a link to another folder. Switch it yourself in a terminal (Use this data, then Advanced).`);
  // Two renames on one disk are instant and safe; across disks they fail.
  const [devHome, devRestored] = await Promise.all([fs.stat(path.dirname(h)), fs.stat(r)]);
  if (devHome.dev !== devRestored.dev) throw new Error(`${r} is on another disk than ${h}. Restore into a folder next to it, then switch.`);
  const pending: PendingSwitch = {
    restored: r, aside: await asideFor(h, now), at: now.toISOString(),
    pid: process.pid, started: await processStart(process.pid).catch(() => ''),
  };
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
    return {
      restored: p.restored, aside: p.aside, at: String(p.at ?? ''),
      ...(typeof p.pid === 'number' ? { pid: p.pid } : {}), ...(typeof p.started === 'string' ? { started: p.started } : {}),
    };
  } catch {
    return null;
  }
}

/** Drop the request, and the last failure's or success's note with it (the user has read it). */
export async function cancelSwitch(home: string): Promise<void> {
  await fs.rm(switchMarkerPath(home), { force: true });
  await fs.rm(switchErrorPath(home), { force: true });
  await fs.rm(switchDonePath(home), { force: true });
}

/** The last switch done and not yet read: the folder now in use came from `restored`, the previous one is at `aside`. */
export async function lastSwitchDone(home: string): Promise<{ restored: string; aside: string; at: string } | null> {
  try {
    const d = JSON.parse(await fs.readFile(switchDonePath(home), 'utf8')) as { restored?: unknown; aside?: unknown; at?: unknown };
    return typeof d.restored === 'string' && typeof d.aside === 'string' ? { restored: d.restored, aside: d.aside, at: String(d.at ?? '') } : null;
  } catch {
    return null;
  }
}

/** The last start's failed switch, in words, or null. */
export async function lastSwitchError(home: string): Promise<string | null> {
  return fs.readFile(switchErrorPath(home), 'utf8').then((t) => t.trim() || null, () => null);
}

/**
 * Delete the data set aside by the last switch, when the person asks. Only that
 * one folder: beside the data folder, with the aside name a switch gives, never a
 * link, never the data folder. The note goes with it.
 */
export async function deletePreviousData(home: string): Promise<string> {
  const h = path.resolve(home);
  const done = await lastSwitchDone(h);
  if (!done) throw new Error('No data set aside by a switch to delete.');
  const aside = path.resolve(done.aside);
  const named = path.dirname(aside) === path.dirname(h) && path.basename(aside).startsWith(`${path.basename(h)}-before-restore-`);
  if (!named || aside === h) throw new Error(`${aside} is not the folder a switch set aside; Walnut leaves it alone.`);
  const st = await fs.lstat(aside).catch(() => null);
  if (st?.isSymbolicLink()) throw new Error(`${aside} is a link; Walnut leaves it alone.`);
  if (st) await fs.rm(aside, { recursive: true, force: true });
  await fs.rm(switchDonePath(h), { force: true });
  return aside;
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
 * for. Never throws. It waits while the server that asked still runs (a second
 * start beside it must not move the folder that server writes); a request older
 * than a day is dropped; a switch that cannot be done leaves the data folder as
 * it was (or puts it back) and says why in a file beside it. When even putting
 * it back fails, the request stays (the next start finishes it) and the outcome
 * is fatal: the server must not start on a missing or empty data folder.
 */
export async function applyPendingSwitch(home: string, deps: SwitchDeps = {}): Promise<SwitchOutcome> {
  const rename = deps.rename ?? ((a: string, b: string) => fs.rename(a, b));
  const h = path.resolve(home);
  const p = await readPendingSwitch(h);
  if (!p) {
    await fs.rm(switchMarkerPath(h), { force: true }).catch(() => {});
    return { kind: 'none' };
  }
  const note = (error: string) => fs.writeFile(switchErrorPath(h), `${new Date().toISOString()} ${error}\n`).catch(() => {});
  const fail = async (error: string): Promise<SwitchOutcome> => {
    await note(error);
    await fs.rm(switchMarkerPath(h), { force: true }).catch(() => {});
    return { kind: 'failed', error };
  };
  if (p.pid && p.pid !== process.pid && (deps.alive ?? pidAlive)(p.pid)) {
    const now = await (deps.started ?? processStart)(p.pid).catch(() => '');
    if (!p.started || !now || now === p.started) return { kind: 'waiting' };
  }
  const at = Date.parse(p.at);
  if (!Number.isFinite(at) || (deps.now ?? Date.now)() - at > SWITCH_MAX_AGE_MS) {
    return fail(`The switch to ${p.restored} was asked on ${p.at || 'an unknown day'}, more than a day ago; Walnut kept its data folder. Ask again if you still want it.`);
  }
  const [hasHome, hasRestored, hasAside] = await Promise.all([exists(h), exists(p.restored), exists(p.aside)]);
  try {
    if (hasHome && hasRestored && !hasAside) {
      await rename(h, p.aside);
      try {
        await rename(p.restored, h);
      } catch (err) {
        try {
          await rename(p.aside, h); // put the old folder back
        } catch (back) {
          const error = `The switch stopped half way (${err instanceof Error ? err.message : String(err)}), and putting ${p.aside} back failed too (${back instanceof Error ? back.message : String(back)}). Nothing was deleted: your data is in ${p.aside}.`;
          await note(error);
          return { kind: 'failed', error, fatal: true }; // the request stays: the next start finishes it
        }
        throw err;
      }
    } else if (!hasHome && hasRestored && hasAside) {
      await rename(p.restored, h); // a start that died between the two renames
    } else if (!hasHome && !hasRestored && hasAside) {
      await rename(p.aside, h); // the restored folder is gone: the old one comes back
      return fail(`The restored folder ${p.restored} was gone; Walnut kept its data folder.`);
    } else if (hasHome && !hasRestored && hasAside) {
      // Done before the request went.
    } else {
      return fail(hasAside
        ? `${p.aside} already exists; Walnut kept its data folder.`
        : `The restored folder ${p.restored} was gone; Walnut kept its data folder.`);
    }
  } catch (err) {
    if (!(await exists(h))) {
      const error = `The switch failed (${err instanceof Error ? err.message : String(err)}) and the data folder is not in place. Nothing was deleted: look in ${p.aside} and ${p.restored}.`;
      await note(error);
      return { kind: 'failed', error, fatal: true };
    }
    return fail(`The switch failed (${err instanceof Error ? err.message : String(err)}); Walnut kept its data folder.`);
  }
  await carryMachineId(p.aside, h).catch(() => {});
  await fs.writeFile(switchDonePath(h), `${JSON.stringify({ restored: p.restored, aside: p.aside, at: new Date().toISOString() })}\n`).catch(() => {});
  await fs.rm(switchMarkerPath(h), { force: true }).catch(() => {});
  await fs.rm(switchErrorPath(h), { force: true }).catch(() => {});
  return { kind: 'switched', aside: p.aside };
}
