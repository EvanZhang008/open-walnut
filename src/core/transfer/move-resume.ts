/**
 * A task move run again after this server's stop cut an earlier run of it short
 * (sessions/engine-switch-restart.ts): what that run set up on the target, or was setting up when
 * the stop came, is found again, so the work is never made a second time beside it.
 *
 * For each piece of this run (same kind and source as one the cut run reached, whose folder is
 * still in the target's task directory):
 *   - set up, and this run's pack of it is the same (HEAD and print of the source checkout, read
 *     the same way on the same host): kept as it is;
 *   - a folder of loose files: unpacked again over the same folder (an unpack overwrites);
 *   - a repository that changed since, or whose set-up's answer the stop cut off (in doubt): this
 *     run's pack is set up IN that copy ('task-move-into-v1'), against what the copy holds now,
 *     read by the target's own daemon (a probe pack). Nothing but this move wrote that copy, and the
 *     start that might have used it is stopped before a rerun (engine-switch-watch.ts). A copy the
 *     target cannot read, or will not take the pack into, leaves this run to a new folder.
 * Each answer of the target that this server's stop cut off is rethrown, never read as a refusal.
 */
import path from 'node:path';
import type { MovedPiece, WorkPiece } from './task-work.js';
import type { PackMeta } from './daemon-transfer-client.js';
import { interruptedByShutdown } from '../server-stopping.js';

/** What a cut run left of one piece. */
export type EarlierPiece =
  | { kind: 'keep'; piece: MovedPiece }
  | { kind: 'unpack'; dest: string }
  /** `confirmed`: the cut run's set-up of it was answered (else its answer was cut off: in doubt). */
  | { kind: 'into'; dest: string; confirmed: boolean };

/** The cut run's piece for `piece`, by kind and source, while its folder is still in the task directory. */
export function earlierPiece(opts: {
  done?: readonly MovedPiece[]; inDoubt?: ReadonlyArray<{ kind: string; source: string; dest: string }>;
  piece: WorkPiece; meta: PackMeta; targetTaskDir: string; present: ReadonlySet<string>;
}): EarlierPiece | null {
  const { piece, meta, targetTaskDir, present } = opts;
  const there = (dest: string): boolean => {
    const rel = path.posix.relative(targetTaskDir, dest);
    return rel === '' || (!rel.startsWith('..') && !path.posix.isAbsolute(rel) && present.has(rel.split('/')[0]!));
  };
  const same = (d: { kind: string; source: string; dest: string }) => d.kind === piece.kind && d.source === piece.source && there(d.dest);
  const prior = opts.done?.find((d) => d.applied && same(d));
  const doubt = prior ? undefined : opts.inDoubt?.find(same);
  const dest = prior?.dest ?? doubt?.dest;
  if (!dest) return null;
  if (piece.kind === 'files') return { kind: 'unpack', dest };
  if (prior && prior.print && meta.print && prior.head && prior.head === meta.head && prior.print === meta.print) return { kind: 'keep', piece: prior };
  return { kind: 'into', dest, confirmed: !!prior };
}

/** What the copy at `dest` on `host` holds now, its HEAD and print as its own daemon reads them, or undefined. */
export async function copyNow(client: typeof import('./daemon-transfer-client.js'), host: string, dest: string, outDir: string): Promise<{ head: string; print: string } | undefined> {
  try {
    const r = await client.packWorkspace(host, { cwd: dest, outDir, noFullBundle: true });
    return r.meta.kind === 'git' && r.meta.head && r.meta.print ? { head: r.meta.head, print: r.meta.print } : undefined;
  } catch (err) {
    if (interruptedByShutdown(err)) throw err;
    return undefined;
  }
}

