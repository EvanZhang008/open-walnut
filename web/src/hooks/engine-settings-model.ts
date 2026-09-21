/**
 * Engine settings view model: the pure half of editing an engine's own config
 * files, shared by Settings › Engines and the composer's per-session popover.
 *
 * Nothing here touches React or the network. It answers three questions the
 * hook asks on every write:
 * - what should a row show the instant the user changes it (optimistic item);
 * - when a write's fresh read lands, how much of it may paint (a late answer
 * places only its own key, rows still in flight keep their optimistic value);
 * - after a failed write, does the control go back or does the truth get
 * re-read (only a server-confirmed "not-written" licenses the revert).
 */
import {
  engineSettingsWriteOutcome,
  type EngineSettingValue,
  type EngineSettingView,
  type EngineSettingsGroupView,
  type EngineSettingsView,
} from '@/api/engine-settings';

/** Replace ONE item in the view, leaving every other row (including another row's in-flight value) alone. */
export function mapItem(
  view: EngineSettingsView,
  key: string,
  fn: (item: EngineSettingView) => EngineSettingView,
): EngineSettingsView {
  return {
    ...view,
    groups: view.groups.map((group) => ({
      ...group,
      items: group.items.map((item) => (item.key === key ? fn(item) : item)),
    })),
  };
}

export function findItem(view: EngineSettingsView | null, key: string): EngineSettingView | undefined {
  for (const group of view?.groups ?? []) {
    const hit = group.items.find((i) => i.key === key);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * Where the value will be read from once the write lands. A write target other
 * than the row's own file is a project overlay, so the status line says "Set in
 * this project (local)" from the first frame instead of flashing "Set in user
 * settings" for the 1 to 3 seconds a remote answer takes.
 */
function landedSource(item: EngineSettingView): Pick<EngineSettingView, 'source' | 'overlay'> {
  if (item.writeTarget.file !== item.file) {
    return { source: 'overlay', overlay: { file: item.writeTarget.file, path: item.writeTarget.path } };
  }
  return { source: 'file', overlay: undefined };
}

/** The row as it should look while its `set` is in flight. */
export function optimisticSet(item: EngineSettingView, value: EngineSettingValue): EngineSettingView {
  // An emptied text field means "use the engine's default", which is an unset.
  const clearsToDefault = item.type === 'text' && value === '';
  if (clearsToDefault) return optimisticReset(item);
  return { ...item, value, invalid: undefined, ...landedSource(item) };
}

/**
 * The row as it should look while its `unset` is in flight. "Default"
 * is only the truth when the key leaves the very layer the value came from and
 * no other layer is known to hold it:
 * - target is the row's own file and the value came from it: default;
 * - target is the row's own file but an overlay is in force: the overlay's
 * value stays in force, nothing changes but `holds`;
 * - target is another file (a project overlay) that holds the value in force:
 * the layer that takes over (the row's own file or the default) is NOT in
 * the view, so the row keeps what it shows until the answer says. A stale
 * truth for a second beats an invented "Default" (measured: 1 to 3 s on a
 * remote host).
 * A legacy-sourced value is read from a file the target is not, so it stays too.
 */
export function optimisticReset(item: EngineSettingView): EngineSettingView {
  const holdsCleared = { ...item, invalid: undefined, writeTarget: { ...item.writeTarget, holds: false } };
  const ownFile = item.writeTarget.file === item.file;
  if (ownFile && (item.source === 'file' || item.source === 'default')) {
    return { ...holdsCleared, value: item.default, source: 'default', overlay: undefined };
  }
  return holdsCleared;
}

export interface MergeLandedInput {
  /** The view on screen when the answer arrived (null when nothing has painted yet). */
  prev: EngineSettingsView | null;
  /** The fresh read the write answered with. */
  next: EngineSettingsView;
  /** The key this write was for. */
  key: string;
  /** This patch's sequence number, taken when it started. */
  seq: number;
  /** The newest patch whose answer has already painted. */
  landedSeq: number;
  /** Keys with a write in flight RIGHT NOW (including `key` itself). */
  savingKeys: readonly string[];
}

/**
 * Fold a write's fresh read into the view on screen.
 *
 * The response is a fresh read of the files, but a read is a snapshot: if a
 * patch started AFTER this one has already painted, its snapshot is the newer
 * truth and this one only gets to place its own key. Otherwise the snapshot
 * replaces the view, except that rows with their own write still in flight keep
 * their optimistic value rather than flashing back to what this snapshot saw
 * before they landed.
 */
export function mergeLanded(input: MergeLandedInput): { view: EngineSettingsView; landedSeq: number } {
  const { prev, next, key, seq, landedSeq, savingKeys } = input;
  if (!prev) return { view: next, landedSeq };
  if (seq < landedSeq) {
    const mine = findItem(next, key);
    return { view: mine ? mapItem(prev, key, () => mine) : prev, landedSeq };
  }
  let merged: EngineSettingsView = next;
  for (const other of savingKeys) {
    if (other === key) continue;
    const inFlight = findItem(prev, other);
    if (inFlight) merged = mapItem(merged, other, () => inFlight);
  }
  return { view: merged, landedSeq: seq };
}

/**
 * What to do with a row after its write failed. Refused before any byte moved:
 * only this row goes back (another row may have its own write in flight). Any
 * other outcome means the file may hold the new value (a deadline that fired
 * after the rename, a read-back that failed after the write), and putting the
 * control back would show the opposite of the disk, so the truth is re-read.
 */
export function decideWriteFailure(err: unknown): 'revert' | 'reload' {
  return engineSettingsWriteOutcome(err) === 'not-written' ? 'revert' : 'reload';
}

/** The group a running session reads (the popover shows only this one). */
export function sessionsGroup(view: EngineSettingsView | null): EngineSettingsGroupView | undefined {
  return view?.groups.find((g) => g.id === 'sessions');
}

/** Every other group, in response order (the popover links to them, the Settings page shows them). */
export function otherGroups(view: EngineSettingsView | null): EngineSettingsGroupView[] {
  return (view?.groups ?? []).filter((g) => g.id !== 'sessions');
}

/**
 * A row whose key has no per-project layer, as the server says (`projectLayer:
 * false`, sent only when the view offers the project scope at all): under
 * "this project only" the popover locks it, because the engine would never
 * read that key from a project file and the server refuses the write.
 */
export function rowLacksProjectLayer(item: EngineSettingView): boolean {
  return item.projectLayer === false;
}

/**
 * Whether a change to this row is felt by the session the popover belongs to:
 * the server marks the rows Walnut's own launch outranks (`honoredHere: false`),
 * and an `appliesOn` value this build does not know is treated as "not
 * honored", because an unknown timing is not a promise.
 */
export function rowHonoredHere(item: EngineSettingView): boolean {
  if (item.honoredHere === false) return false;
  const applies = item.appliesOn as string | undefined;
  return applies === undefined || applies === 'next-turn' || applies === 'new-session';
}
