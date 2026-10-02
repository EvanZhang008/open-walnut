/**
 * Who is reading through Walnut's Full Disk Access right now, and why.
 *
 * Core features are listed in darwin.ts (they are switched on by config). A plugin
 * says so here through `walnut.macos.useFullDiskAccess(reason)`, and its protected
 * reads are refused unless it has: Settings → macOS Access → Full Disk Access then
 * names every reason the grant is used for, so nothing reads through it silently.
 */

export interface FullDiskAccessUse {
  /** Plugin id, for logs and tests. */
  owner: string;
  /** Lower-case clause that completes "Lets Walnut …", e.g. "mirror your Mac's Focus". */
  reason: string;
  /** A protected file this use reads, so the row can check the grant without a core feature. */
  probe?: string;
}

const uses = new Map<symbol, FullDiskAccessUse>();
const listeners = new Set<() => void>();

/** Register a use; the returned function releases it (idempotent). */
export function declareFullDiskAccessUse(use: FullDiskAccessUse): () => void {
  const key = Symbol(use.owner);
  uses.set(key, { ...use });
  notify();
  return () => {
    if (uses.delete(key)) notify();
  };
}

export function fullDiskAccessUses(): FullDiskAccessUse[] {
  return [...uses.values()];
}

/** True while `owner` holds at least one use. */
export function holdsFullDiskAccessUse(owner: string): boolean {
  for (const use of uses.values()) if (use.owner === owner) return true;
  return false;
}

/** Called on every change (the report cache listens, so the row updates at once). */
export function onFullDiskAccessUsesChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Tests. */
export function resetFullDiskAccessUses(): void {
  uses.clear();
}

function notify(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // a listener's failure must not undo the declaration
    }
  }
}
