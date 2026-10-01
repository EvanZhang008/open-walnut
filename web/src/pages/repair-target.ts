/**
 * Where an "Improve Walnut" / "Fix Walnut" draft points: Walnut's own source.
 *
 * GET /api/config carries `selfRepair` (server: core/self-repair/walnut-source.ts).
 * Its `source` is the checkout to edit (the running checkout, a configured one, or
 * an existing `~/open-walnut` clone). With no source but `available`, the server
 * clones upstream into `cloneDir` on the first repair Start, so the draft can
 * already point there. Every install that can repair gets a target, npm installs
 * included; only `available: false` (a cloud replica, no git, an occupied clone
 * path) has none, and then no repair entry renders at all.
 *
 * Pure: no React, no IO. Unit-tested in tests/web/repair-target.test.ts.
 */
import type { SelfRepairInfo } from '@/api/config';

export interface WalnutRepairTarget {
  /** The folder the repair session runs in (the checkout, or the clone to be). */
  dir: string;
  /** No checkout yet: Start clones `repoUrl` into `dir` first. */
  cloneNeeded: boolean;
  repoUrl: string;
}

export function deriveRepairTarget(info: SelfRepairInfo | null | undefined): WalnutRepairTarget | null {
  if (!info?.available) return null;
  const dir = info.source?.dir || info.cloneDir;
  if (!dir) return null;
  return { dir, cloneNeeded: !info.source, repoUrl: info.repoUrl };
}

/** The repair draft's one-line hint: says WHERE Walnut's code lives, or will. */
export function repairHint(target: WalnutRepairTarget | null | undefined): string {
  if (!target) {
    return "Opens a session in Walnut's own source to fix it. Paste a screenshot (⌘V) if you have one.";
  }
  if (target.cloneNeeded) {
    return `Walnut's source is not on this computer yet. Start clones ${target.repoUrl} into ${target.dir} first, then opens a session there.`;
  }
  return `Opens a session in Walnut's own source at ${target.dir}. Describe what to change or fix; paste a screenshot (⌘V) if you have one.`;
}
