/**
 * Object identities for the history-parts pass (SessionChatHistory).
 *
 * The pass re-runs whenever the rows change: every page of "Load earlier turns",
 * every refetch. It mints objects of its own (a run's `memberMsgs` array, a row
 * merged with the reasoning before it, a system group's members), and the
 * memoized row components compare their props by identity. Minted fresh on each
 * pass, every row on screen re-rendered for every page: reading back to the
 * start of a long session cost a re-render of all rows per page (2026-10-30, a
 * 940-turn transcript took 3 to 5 s a page by its end).
 *
 * So each derived object is remembered against the row object it is made from,
 * and a later pass deriving it from the same inputs (compared by identity) gets
 * the object it had. Rows are immutable in the history state, so the same row
 * object and the same inputs always derive an equal value.
 */
export class PartIdentity {
  private byRow = new WeakMap<object, Map<string, { deps: readonly unknown[]; value: unknown }>>();

  /** `make()`, or what it returned before for this row, kind and inputs. */
  derive<T>(row: object, kind: string, deps: readonly unknown[], make: () => T): T {
    let slot = this.byRow.get(row);
    if (!slot) {
      slot = new Map();
      this.byRow.set(row, slot);
    }
    const hit = slot.get(kind);
    if (hit && sameItems(hit.deps, deps)) return hit.value as T;
    const value = make();
    slot.set(kind, { deps, value });
    return value;
  }

  /** The array an earlier pass made with exactly these items, else `items`
   *  itself. Call it once the array is complete: the array it returns is shared. */
  list<T extends object>(kind: string, items: T[]): T[] {
    if (items.length === 0) return items;
    return this.derive(items[0], `list:${kind}`, items, () => items);
  }
}

function sameItems(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
