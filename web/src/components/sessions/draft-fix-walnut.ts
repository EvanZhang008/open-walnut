/**
 * Fix Walnut in the v6 draft (DraftFixWalnutRow.tsx): the rules, no React. A plain draft's key
 * makes it the repair draft (MainPage's repair seed) and remembers where it stood; every way back
 * (the key again, the ×, a place picked from Recent, Quick chat) gives that back.
 */
import type { WalnutRepairTarget } from '@/pages/repair-target';
import { tildePath } from '@/utils/home-folder';
import type { DraftColumn } from './draft-column';
import { withHomeFolder } from './draft-home-default';

export const isFixWalnutDraft = (d: Pick<DraftColumn, 'intent'>): boolean => d.intent === 'fix-walnut';

/** `next` (the repair draft made from `prev`) remembering where `prev` stood. */
export function withFixWalnutPrev(prev: DraftColumn, next: DraftColumn): DraftColumn {
  if (!isFixWalnutDraft(next) || isFixWalnutDraft(prev)) return next;
  return {
    ...next,
    fixWalnutPrev: {
      cwd: prev.cwd, host: prev.host ?? null, hostLabel: prev.hostLabel, cwdPinned: prev.cwdPinned,
      openedCwd: prev.openedCwd, openedHost: prev.openedHost,
      engine: prev.meta.engine, model: prev.meta.model,
    },
  };
}

/** The repair draft back to a plain one: where it stood before, else the home folder as a fresh draft. */
export function leaveFixWalnut(d: DraftColumn): DraftColumn {
  if (!isFixWalnutDraft(d)) return d;
  const { intent: _intent, fixWalnutPrev: prev, ...rest } = d;
  if (!prev?.cwd) {
    return withHomeFolder({ ...rest, cwd: '', host: null, hostLabel: undefined, cwdPinned: false, openedCwd: '', openedHost: null });
  }
  // An engine the repair dropped comes back; one picked while it was the repair draft stays.
  const meta = !rest.meta.engine && prev.engine ? { ...rest.meta, engine: prev.engine, model: prev.model } : rest.meta;
  return {
    ...rest, meta,
    cwd: prev.cwd, host: prev.host, hostLabel: prev.hostLabel, cwdPinned: prev.cwdPinned ?? false,
    openedCwd: prev.openedCwd ?? prev.cwd, openedHost: prev.openedHost ?? prev.host,
  };
}

/** The words beside the key: where the session runs. */
export function fixWalnutWhere(target: WalnutRepairTarget, home?: string): string {
  const dir = tildePath(target.dir, home);
  return target.cloneNeeded ? `Start clones Walnut's source into ${dir} first` : `in ${dir}`;
}
