/**
 * The rows of Settings, Tasks, Tags (web/src/components/settings/sections/TagsSection.tsx
 * `buildTagRows`): one per namespace and per plain tag, so one switch covers every
 * `ticket:…` tag.
 *
 * The defect this pins: a plugin hid one exact tag (`marina:pinned`) and the tag
 * was folded into its namespace's row, whose switch read the NAMESPACE's state ("shown")
 * while the tag itself was hidden. A tag with a rule of its own now has its own row.
 */
import { describe, it, expect } from 'vitest';
import { buildTagRows } from '../../web/src/components/settings/sections/TagsSection';
import type { TagDisplayRule } from '../../web/src/stores/tag-display-store';
import { DEFAULT_TAG_DISPLAY_RULES } from '../../src/core/tag-display-rules';

const counts = [
  { tag: 'ticket:V1', count: 3 },
  { tag: 'ticket:V2', count: 1 },
  { tag: 'ticket-id:abc', count: 4 },
  { tag: 'marina:pinned', count: 5 },
  { tag: 'marina:other', count: 1 },
  { tag: 'walnut:external-sessions', count: 9 },
  { tag: 'plain', count: 2 },
];

const plugin = (pattern: string): TagDisplayRule => ({ pattern, display: 'hidden', source: 'plugin', pluginId: 'marina', pluginName: 'Marina' } as TagDisplayRule);

describe('buildTagRows', () => {
  it('folds tags into one row per namespace and skips Walnut machine tags', () => {
    const rows = buildTagRows(counts, []);
    expect(rows.map((row) => row.pattern)).toEqual(['marina:*', 'ticket-id:*', 'ticket:*', 'plain']);
    expect(rows.find((row) => row.pattern === 'ticket:*')).toMatchObject({ label: 'ticket:', namespace: true, tags: 2, uses: 4 });
  });

  it('gives a tag with an exact rule its own row, out of its namespace', () => {
    const rows = buildTagRows(counts, [plugin('marina:pinned'), plugin('ticket-id:*')]);
    const exact = rows.find((row) => row.pattern === 'marina:pinned');
    expect(exact).toMatchObject({ label: 'marina:pinned', namespace: false, tags: 1, uses: 5, probe: 'marina:pinned' });
    // The namespace row keeps only the tags no exact rule claims.
    expect(rows.find((row) => row.pattern === 'marina:*')).toMatchObject({ tags: 1, uses: 1 });
    // A namespace rule still folds its tags into the namespace row.
    expect(rows.find((row) => row.pattern === 'ticket-id:*')).toMatchObject({ namespace: true, tags: 1 });
  });

  it('gives every label a row of its own, and a label: row that counts them and sets them all', () => {
    const rows = buildTagRows([{ tag: 'label:oncall', count: 3 }, { tag: 'label:bug', count: 2 }], [...DEFAULT_TAG_DISPLAY_RULES]);
    expect(rows.find((row) => row.pattern === 'label:*')).toMatchObject({ label: 'label:', namespace: true, tags: 2, uses: 5 });
    expect(rows.find((row) => row.pattern === 'label:oncall')).toMatchObject({ namespace: false, tags: 1, uses: 3 });
    // Walnut's own date keys are listed (so they can be shown), though no task stores them.
    expect(rows.find((row) => row.pattern === 'created:*')).toMatchObject({ namespace: true, tags: 0 });
    expect(rows.find((row) => row.pattern === 'updated:*')).toMatchObject({ namespace: true, tags: 0 });
  });

  it('keeps a row for an exact rule whose tag no task carries any more', () => {
    const rows = buildTagRows([], [plugin('marina:gone')]);
    expect(rows.map((row) => row.pattern)).toEqual(['marina:gone']);
    expect(rows[0]).toMatchObject({ tags: 0, uses: 0 });
  });
});
