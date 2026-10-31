/**
 * The layout record (web/src/utils/layout-record.ts): Home's and Org's columns, the focused
 * task and the chat slot's ask, kept as localStorage keys the ui-prefs mirror writes to disk.
 * 2026-10-31: they lived in sessionStorage, which the Mac app drops on every relaunch.
 */
import { describe, it, expect } from 'vitest';
import {
  COLUMN_FIELDS, LAYOUT_FIELDS, LAYOUT_PREFIX, createStripWriter, decodeField, dropSavedColumn, encodeField, healedLayoutValue,
  parseSlots, readColumns, readLayoutField, readString, writeColumns, writeLayoutField, type LayoutField,
} from '../../web/src/utils/layout-record';
import { syncable } from '../../web/src/utils/ui-prefs-sync';
import { syncableKey } from '../../src/core/ui-prefs-keys';

class MemStore {
  map = new Map<string, string>();
  getItem(k: string) { return this.map.get(k) ?? null; }
  setItem(k: string, v: string) { this.map.set(k, String(v)); }
  removeItem(k: string) { this.map.delete(k); }
}

describe('layout record: every field goes to disk', () => {
  it('each field key is mirrored by the client and accepted by the server', () => {
    for (const [field, key] of Object.entries(LAYOUT_FIELDS)) {
      expect(key.startsWith(LAYOUT_PREFIX), field).toBe(true);
      expect(syncable(key), `${field} must be mirrored to ui-prefs.json`).toBe(true);
      expect(syncableKey(key), `${field} must be accepted by the server`).toBe(true);
    }
  });
});

describe('layout record: values', () => {
  it('round-trips a versioned value', () => {
    expect(decodeField(encodeField(['a']))).toEqual(['a']);
    expect(decodeField(encodeField('x'))).toBe('x');
  });
  it('reads nothing from a value it cannot read', () => {
    expect(decodeField(null)).toBeUndefined();
    expect(decodeField('not json')).toBeUndefined();
    expect(decodeField('"bare"')).toBeUndefined();
    expect(decodeField('{"value":1}')).toBeUndefined();
  });
  it('parses the record shape and the legacy string[]', () => {
    expect(parseSlots(['a', { id: 'b', locked: true }, { id: '' }, 3, null])).toEqual([
      { id: 'a', locked: false }, { id: 'b', locked: true },
    ]);
    expect(parseSlots('nope')).toEqual([]);
  });
});

describe('layout record: read and write', () => {
  it('writes, reads back, and clears on null by writing a cleared value', () => {
    const local = new MemStore();
    writeLayoutField('homeFocusedTask', 'task-1', local);
    expect(readLayoutField('homeFocusedTask', { local, session: null })).toBe('task-1');
    writeLayoutField('homeFocusedTask', null, local);
    // Kept as a key: a missing key would adopt the server's older copy at the next boot.
    expect(local.getItem(LAYOUT_FIELDS.homeFocusedTask)).toBe(encodeField(null));
    expect(readString('homeFocusedTask', { local, session: null })).toBeNull();
  });

  it('a key this browser never had stays missing on a clear', () => {
    const local = new MemStore();
    writeLayoutField('askAgent', null, local);
    expect(local.map.size).toBe(0);
  });

  it('does not rewrite an unchanged value (no fresh stamp for the mirror)', () => {
    const local = new MemStore();
    writeLayoutField('askAgent', 'mentor', local);
    let writes = 0;
    const orig = local.setItem.bind(local);
    local.setItem = (k, v) => { writes++; orig(k, v); };
    writeLayoutField('askAgent', 'mentor', local);
    expect(writes).toBe(0);
  });

  it('a tab open across the upgrade adopts its sessionStorage value once', () => {
    const local = new MemStore();
    const session = new MemStore();
    session.setItem('open-walnut-home-session-columns', JSON.stringify([{ id: 's1', locked: true }, 's2']));
    expect(readLayoutField('homeColumns', { local, session })).toEqual([{ id: 's1', locked: true }, 's2']);
    expect(session.map.size).toBe(0);
    expect(parseSlots(decodeField(local.getItem(LAYOUT_FIELDS.homeColumns)))).toEqual([
      { id: 's1', locked: true }, { id: 's2', locked: false },
    ]);
    // A later read comes from the record.
    expect(parseSlots(readLayoutField('homeColumns', { local, session }))).toHaveLength(2);
  });

  it('adopts the legacy string keys as they were', () => {
    const local = new MemStore();
    const session = new MemStore();
    session.setItem('walnut:ask-slot:selected', 'task-9');
    session.setItem('open-walnut-home-focused-task', 'task-3');
    expect(readLayoutField('askSelected', { local, session })).toBe('task-9');
    expect(readLayoutField('homeFocusedTask', { local, session })).toBe('task-3');
  });

  it('a phone-width page adopts the old single strip too', () => {
    const local = new MemStore();
    const session = new MemStore();
    session.setItem('open-walnut-home-session-columns', '["p1"]');
    expect(parseSlots(readLayoutField('phoneColumns', { local, session }))).toEqual([{ id: 'p1', locked: false }]);
  });
});

describe('layout record: columns', () => {
  it('writeColumns leaves out placeholders and keeps locks', () => {
    const local = new MemStore();
    const stores = { local, session: null };
    writeColumns('homeColumns', [
      { id: 'draft:new-1', locked: false }, { id: 'pending:x', locked: false },
      { id: 's1', locked: false }, { id: 's2', locked: true },
    ], local);
    expect(readColumns('homeColumns', stores)).toEqual([{ id: 's1', locked: false }, { id: 's2', locked: true }]);
    dropSavedColumn('homeColumns', 's1', local);
    expect(readColumns('homeColumns', stores)).toEqual([{ id: 's2', locked: true }]);
    writeColumns('homeColumns', [{ id: 'draft:only', locked: false }], local);
    expect(readColumns('homeColumns', stores)).toEqual([]);
    expect(readString('homeFocusedTask', stores)).toBeNull();
  });
});

describe('layout record: crash heal', () => {
  it('the soft heal keeps the locked columns of a column field; the hard heal clears them', () => {
    for (const field of COLUMN_FIELDS) {
      const raw = encodeField([{ id: 'a', locked: false }, { id: 'b', locked: true }]);
      expect(parseSlots(decodeField(healedLayoutValue(LAYOUT_FIELDS[field], raw, true)))).toEqual([{ id: 'b', locked: true }]);
      expect(healedLayoutValue(LAYOUT_FIELDS[field], raw, false)).toBe(encodeField(null));
      expect(healedLayoutValue(LAYOUT_FIELDS[field], encodeField(['a']), true)).toBe(encodeField(null));
    }
  });
  it('clears every other field, by writing a cleared value', () => {
    const others = (Object.keys(LAYOUT_FIELDS) as LayoutField[]).filter((f) => !COLUMN_FIELDS.includes(f));
    for (const f of others) expect(healedLayoutValue(LAYOUT_FIELDS[f], encodeField('x'), true)).toBe(encodeField(null));
  });
});

describe('layout record: two windows and their pins', () => {
  const slots = (local: MemStore) => readColumns('homeColumns', { local, session: null });
  it("a window keeps the pins another window saved; it lets go of the ones it unlocked or closed", () => {
    const local = new MemStore();
    const a = createStripWriter('homeColumns');
    const b = createStripWriter('homeColumns');
    a([{ id: 'x', locked: false }, { id: 'p1', locked: true }], local);
    // B opened before A pinned p1 and never showed it: its write keeps p1.
    b([{ id: 'y', locked: false }], local);
    expect(slots(local)).toEqual([{ id: 'y', locked: false }, { id: 'p1', locked: true }]);
    // B pins p2, then closes it: p2 is released, p1 still kept.
    b([{ id: 'y', locked: false }, { id: 'p2', locked: true }], local);
    b([{ id: 'y', locked: false }], local);
    expect(slots(local)).toEqual([{ id: 'y', locked: false }, { id: 'p1', locked: true }]);
    // A unlocks p1: released for A; B's next write no longer sees it as a pin.
    a([{ id: 'x', locked: false }, { id: 'p1', locked: false }], local);
    b([{ id: 'y', locked: false }], local);
    expect(slots(local)).toEqual([{ id: 'y', locked: false }]);
  });
});
