/**
 * The Org page's locked side panels belong to the node they were locked under (2026-11-16, the
 * user: "the page I lock shows on every VP ... I locked it under this VP, it should only show
 * under this VP"). One list in the layout record (`orgColumns`) holds every node's pins, each
 * slot naming its `node`; the strip shows only the selected node's.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { adoptLegacyPins, pinsOfNode, setNodePins, type OrgPin } from '../../web/src/components/org/org-side-columns';
import { createStripWriter, healedLayoutValue, LAYOUT_FIELDS, readColumns, writeColumns } from '../../web/src/utils/layout-record';

class MemStore {
  map = new Map<string, string>();
  getItem(k: string) { return this.map.get(k) ?? null; }
  setItem(k: string, v: string) { this.map.set(k, String(v)); }
  removeItem(k: string) { this.map.delete(k); }
}

const A = 'project:alpha';
const B = 'project:beta';

describe('org pins per node', () => {
  it('a node shows only its own pins, in their order, and switching back keeps them', () => {
    let pins: OrgPin[] = [];
    pins = setNodePins(pins, A, [{ id: 'task:a1', locked: true }, { id: 'task:a2', locked: true }]);
    pins = setNodePins(pins, B, [{ id: 'task:b1', locked: true }]);
    expect(pinsOfNode(pins, A).map((p) => p.id)).toEqual(['task:a1', 'task:a2']);
    expect(pinsOfNode(pins, B).map((p) => p.id)).toEqual(['task:b1']);
    // B's change leaves A's pins as they were.
    pins = setNodePins(pins, B, []);
    expect(pinsOfNode(pins, A).map((p) => p.id)).toEqual(['task:a1', 'task:a2']);
    expect(pinsOfNode(pins, B)).toEqual([]);
  });

  it('a node\'s change keeps its place among the others, so a switch rewrites nothing', () => {
    const pins: OrgPin[] = [{ id: 'task:a1', locked: true, node: A }, { id: 'task:b1', locked: true, node: B }, { id: 'task:a2', locked: true, node: A }];
    expect(setNodePins(pins, A, pinsOfNode(pins, A))).toEqual([
      { id: 'task:a1', locked: true, node: A }, { id: 'task:a2', locked: true, node: A }, { id: 'task:b1', locked: true, node: B },
    ]);
    const settled = setNodePins(pins, A, pinsOfNode(pins, A));
    expect(setNodePins(settled, A, pinsOfNode(settled, A))).toEqual(settled);
    expect(setNodePins(settled, B, pinsOfNode(settled, B))).toEqual(settled);
  });

  it('one task can be locked beside two nodes, each its own pin', () => {
    let pins: OrgPin[] = setNodePins([], A, [{ id: 'task:x', locked: true }]);
    pins = setNodePins(pins, B, [{ id: 'task:x', locked: true }]);
    pins = setNodePins(pins, A, []);
    expect(pins).toEqual([{ id: 'task:x', locked: true, node: B }]);
  });

  it('a pin saved before pins had a node goes to the row of its task, else the node shown', () => {
    const legacy: OrgPin[] = [{ id: 'task:personal', locked: true }, { id: 'session:gone', locked: true }, { id: 'task:kept', locked: true, node: B }];
    const owner = (id: string) => (id === 'task:personal' ? 'project:personal' : undefined);
    expect(adoptLegacyPins(legacy, owner, A)).toEqual([
      { id: 'task:personal', locked: true, node: 'project:personal' },
      { id: 'session:gone', locked: true, node: A },
      { id: 'task:kept', locked: true, node: B },
    ]);
    // Nothing to adopt: the same list, so the page sets no new state.
    const done = setNodePins([], A, [{ id: 'task:a', locked: true }]);
    expect(adoptLegacyPins(done, owner, B)).toBe(done);
  });

  it('a pin under a node the page no longer has is adopted again, and one panel is kept once per node', () => {
    const pins: OrgPin[] = [
      { id: 'task:personal', locked: true, node: 'project:renamed-away' },
      { id: 'task:a1', locked: true, node: A },
      { id: 'task:a1', locked: true },
      { id: 'task:a1', locked: true, node: A },
    ];
    const owner = (id: string) => (id === 'task:personal' ? 'project:personal' : A);
    expect(adoptLegacyPins(pins, owner, B, (n) => n === A || n === 'project:personal')).toEqual([
      { id: 'task:personal', locked: true, node: 'project:personal' },
      { id: 'task:a1', locked: true, node: A },
    ]);
  });

  it('the record keeps each pin\'s node through a write, a read, a crash heal and a second window', () => {
    const local = new MemStore();
    writeColumns('orgColumns', [{ id: 'task:a1', locked: true, node: A }, { id: 'task:b1', locked: true, node: B }], local);
    expect(readColumns('orgColumns', { local, session: null })).toEqual([
      { id: 'task:a1', locked: true, node: A }, { id: 'task:b1', locked: true, node: B },
    ]);
    const healed = healedLayoutValue(LAYOUT_FIELDS.orgColumns, local.getItem(LAYOUT_FIELDS.orgColumns), true);
    expect(healed).toContain(`"node":"${A}"`);
    expect(healed).toContain(`"node":"${B}"`);
    // Home's columns carry no node and are written as before.
    writeColumns('homeColumns', [{ id: 's1', locked: true }], local);
    expect(local.getItem(LAYOUT_FIELDS.homeColumns)).toBe(JSON.stringify({ v: 1, value: [{ id: 's1', locked: true }] }));

    // Two windows: both show task:x locked under A and B, then one unlocks it under B only.
    local.map.clear();
    const w1 = createStripWriter('orgColumns');
    const w2 = createStripWriter('orgColumns');
    w1([{ id: 'task:x', locked: true, node: A }, { id: 'task:x', locked: true, node: B }], local);
    w2([{ id: 'task:x', locked: true, node: A }, { id: 'task:x', locked: true, node: B }], local);
    w2([{ id: 'task:x', locked: true, node: A }], local);
    expect(readColumns('orgColumns', { local, session: null })).toEqual([{ id: 'task:x', locked: true, node: A }]);
  });

  // The class: a piece of OrgPage that reads or sets the pins without the node shows one node's pins
  // beside every node. Every pin write goes through the node, and the strip is built from shownPins.
  it('OrgPage builds its strip from the node\'s pins and sets pins only by node', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../web/src/pages/OrgPage.tsx'), 'utf8');
    const stripCalls = [...src.matchAll(/orgStripView\(([^;]*)\)/g)].map((m) => m[1]);
    expect(stripCalls.length).toBeGreaterThan(0);
    for (const call of stripCalls) expect(call, 'the strip reads shownPins, never every pin').not.toMatch(/(^|[^A-Za-z])pins\b/);
    const setCalls = [...src.matchAll(/setPins\(([^\n]*)/g)].map((m) => m[1]);
    expect(setCalls.length).toBeGreaterThan(0);
    for (const call of setCalls) expect(call, `setPins must name the node: ${call}`).toMatch(/setNodePins|adoptLegacyPins|\.node\b/);
  });
});
