/**
 * Group chip sentinels in the pinned tiers (2026-08-22 fix).
 *
 * The chip that heads a virtual group is a real dnd-kit sortable unit, and its id has
 * to be in the tier's SortableContext items for dnd-kit to displace it and to measure
 * it. These are the pure pieces that build and prune that id list; the on-screen half
 * lives in tests/e2e/browser/pinned-group-drag.spec.ts.
 */
import { describe, it, expect } from 'vitest';
import type { Task } from '@open-walnut/core';
import {
  groupSortableId, parseGroupSentinelGid, isGroupSentinel, taskIdsOnly,
  withGroupSentinels, pruneOrphanSentinels,
  intoFolderId, isIntoFolderId, parseIntoFolderId, folderWithin,
  tierLabelId, isTierLabelId, tierLabelProject, withProjectLabels, runProjectOf, pruneTierLabels,
  joinCardId, isJoinCardId, parseJoinCardId,
  slotFits, staysInFolder, type SlotRules,
} from '@/components/tasks/tier-group-sentinels';

function task(id: string, group_id?: string): Task {
  return { id, title: id, status: 'todo', source: 'local', created_at: '', updated_at: '', ...(group_id ? { group_id } : {}) } as Task;
}

const byId = (tasks: Task[]) => new Map(tasks.map((t) => [t.id, t]));

describe('sentinel ids', () => {
  it('round-trips a gid through a built-in tier', () => {
    const id = groupSortableId('g_abc', 'focus');
    expect(id).toBe('group:g_abc:focus');
    expect(isGroupSentinel(id)).toBe(true);
    expect(parseGroupSentinelGid(id)).toBe('g_abc');
  });

  it('round-trips through a custom tier id', () => {
    expect(parseGroupSentinelGid(groupSortableId('g_abc', 'ct_12345678'))).toBe('g_abc');
  });

  it('taskIdsOnly keeps real ids and their order', () => {
    expect(taskIdsOnly(['group:g1:focus', 'a', 'b', 'group:g2:focus', 'c'])).toEqual(['a', 'b', 'c']);
  });

  it('taskIdsOnly strips separator sentinels too — pin order must be task ids only', () => {
    // This is the single guard between the sentinel-bearing arrays and the
    // server's pin_order-by-position assignment; a sep_* id would eat a slot.
    expect(taskIdsOnly(['sep_x1', 'a', 'group:g1:focus', 'b', 'sep_x2'])).toEqual(['a', 'b']);
  });
});

describe('withGroupSentinels', () => {
  it('inserts one sentinel immediately before each group run', () => {
    const tasks = [task('a'), task('b', 'g1'), task('c', 'g1'), task('d')];
    expect(withGroupSentinels(['a', 'b', 'c', 'd'], tasks, 'focus'))
      .toEqual(['a', 'group:g1:focus', 'b', 'c', 'd']);
  });

  it('gives a one-member group a sentinel too (a lone member still shows its chip)', () => {
    const tasks = [task('a', 'g1'), task('b')];
    expect(withGroupSentinels(['a', 'b'], tasks, 'wait'))
      .toEqual(['group:g1:wait', 'a', 'b']);
  });

  it('handles two adjacent groups without merging them', () => {
    const tasks = [task('a', 'g1'), task('b', 'g1'), task('c', 'g2'), task('d', 'g2')];
    expect(withGroupSentinels(['a', 'b', 'c', 'd'], tasks, 'focus'))
      .toEqual(['group:g1:focus', 'a', 'b', 'group:g2:focus', 'c', 'd']);
  });

  it('is idempotent — re-running does not double up sentinels', () => {
    const tasks = [task('a'), task('b', 'g1'), task('c', 'g1')];
    const once = withGroupSentinels(['a', 'b', 'c'], tasks, 'focus');
    expect(withGroupSentinels(once, tasks, 'focus')).toEqual(once);
  });

  it('encodes the tier, so the same group in two tiers gets distinct ids', () => {
    const tasks = [task('a', 'g1'), task('b', 'g1')];
    expect(withGroupSentinels(['a'], tasks, 'focus')[0]).toBe('group:g1:focus');
    expect(withGroupSentinels(['b'], tasks, 'backlog')[0]).toBe('group:g1:backlog');
  });

  it('leaves an ungrouped tier untouched', () => {
    const tasks = [task('a'), task('b')];
    expect(withGroupSentinels(['a', 'b'], tasks, 'focus')).toEqual(['a', 'b']);
  });
});

describe('pruneOrphanSentinels', () => {
  const tasks = [task('a'), task('b', 'g1'), task('c', 'g1')];

  it('keeps a sentinel that still heads its run', () => {
    const ids = ['a', 'group:g1:focus', 'b', 'c'];
    expect(pruneOrphanSentinels(ids, byId(tasks), null)).toEqual(ids);
  });

  it('drops a sentinel whose members were all filtered out', () => {
    // A search or project scope hid b and c; the chip would otherwise be an items
    // entry with no element (no rect) and a header above nothing.
    expect(pruneOrphanSentinels(['a', 'group:g1:focus'], byId(tasks), null)).toEqual(['a']);
  });

  it('keeps the sentinel being dragged even with no members after it', () => {
    // Collapse-on-drag deliberately removes the members; the chip IS the cluster.
    expect(pruneOrphanSentinels(['a', 'group:g1:focus'], byId(tasks), 'group:g1:focus'))
      .toEqual(['a', 'group:g1:focus']);
  });

  it('drops a sentinel followed by a DIFFERENT group', () => {
    const two = [...tasks, task('d', 'g2')];
    expect(pruneOrphanSentinels(['group:g1:focus', 'group:g2:focus', 'd'], byId(two), null))
      .toEqual(['group:g2:focus', 'd']);
  });

  it('returns the same array identity when there is nothing to prune', () => {
    // SortableContext re-registers every item on a new `items` identity (React #185).
    const ids = ['a', 'b'];
    expect(pruneOrphanSentinels(ids, byId(tasks), null)).toBe(ids);
  });

  it('drops separator ids when EVERY card is filtered out, keeps them otherwise', () => {
    // renderTierItems draws no line in a card-less tier (nothing to divide), so a
    // surviving sep_* id would be an items entry with no element and no rect.
    expect(pruneOrphanSentinels(['sep_x1', 'sep_x2'], byId(tasks), null)).toEqual([]);
    const ids = ['sep_x1', 'a'];
    expect(pruneOrphanSentinels(ids, byId(tasks), null)).toEqual(ids);
  });

  it('a chip separated from its member by a line still heads its run', () => {
    // Mid-drag a line can sit between a chip and the group's first member; the
    // chip must not vanish for that frame.
    const ids = ['group:g1:focus', 'sep_x1', 'b', 'c'];
    expect(pruneOrphanSentinels(ids, byId(tasks), null)).toEqual(ids);
  });
});

// Nested folders (2026-09-30): a folder with no card of its own in a tier is still a
// row there (its heading), and only a row in `items` slides with a drag and takes a
// drop. Tree used below: top > mid > leaf, with cards only in leaf (and `top2`).
describe('nested folders', () => {
  const parentOf = new Map([['mid', 'top'], ['leaf', 'mid']]);
  const tasks = [task('a'), task('l1', 'leaf'), task('l2', 'leaf'), task('m1', 'mid'), task('t1', 'top2')];

  it('gives every ancestor a sentinel, root first, ahead of the first subtree row', () => {
    expect(withGroupSentinels(['a', 'l1', 'l2', 't1'], tasks, 'focus', parentOf)).toEqual([
      'a', 'group:top:focus', 'group:mid:focus', 'group:leaf:focus', 'l1', 'l2', 'group:top2:focus', 't1',
    ]);
  });

  it('draws each folder once: a parent with its own cards after a subfolder keeps one sentinel', () => {
    // nestFolderUnits puts mid's own card before leaf's; the sentinel for mid must
    // not come back when leaf's run ends.
    expect(withGroupSentinels(['m1', 'l1'], tasks, 'focus', parentOf)).toEqual([
      'group:top:focus', 'group:mid:focus', 'm1', 'group:leaf:focus', 'l1',
    ]);
  });

  it('is idempotent with ancestors', () => {
    const once = withGroupSentinels(['a', 'l1', 'l2'], tasks, 'focus', parentOf);
    expect(withGroupSentinels(once, tasks, 'focus', parentOf)).toEqual(once);
  });

  it('keeps an ancestor sentinel while the next card sits anywhere under it', () => {
    const ids = ['group:top:focus', 'group:mid:focus', 'group:leaf:focus', 'l1'];
    expect(pruneOrphanSentinels(ids, byId(tasks), null, parentOf)).toEqual(ids);
  });

  it('drops an ancestor whose whole subtree was filtered out', () => {
    const ids = ['group:top:focus', 'group:mid:focus', 'group:leaf:focus', 'a'];
    expect(pruneOrphanSentinels(ids, byId(tasks), null, parentOf)).toEqual(['a']);
  });

  it('keeps the headings above a dragged subfolder (its cards are collapsed away)', () => {
    const ids = ['group:top:focus', 'group:mid:focus', 'group:leaf:focus', 'a'];
    expect(pruneOrphanSentinels(ids, byId(tasks), 'group:leaf:focus', parentOf))
      .toEqual(['group:top:focus', 'group:mid:focus', 'group:leaf:focus', 'a']);
  });

  it('without a tree an ancestor-looking sentinel is an ordinary orphan', () => {
    expect(pruneOrphanSentinels(['group:top:focus', 'l1'], byId(tasks), null)).toEqual(['l1']);
  });

  it('folderWithin walks up the tree and survives a cycle', () => {
    expect(folderWithin('leaf', 'top', parentOf)).toBe(true);
    expect(folderWithin('leaf', 'leaf', parentOf)).toBe(true);
    expect(folderWithin('top', 'leaf', parentOf)).toBe(false);
    expect(folderWithin(undefined, 'top', parentOf)).toBe(false);
    expect(folderWithin('x', 'top', new Map([['x', 'y'], ['y', 'x']]))).toBe(false);
  });
});

describe('into-folder target ids', () => {
  it('round-trips a folder and a tier, custom tiers included', () => {
    const id = intoFolderId('g_abc', 'ct_12345678');
    expect(isIntoFolderId(id)).toBe(true);
    expect(parseIntoFolderId(id)).toEqual({ groupId: 'g_abc', tier: 'ct_12345678' });
  });

  it('is never mistaken for a chip sentinel, so it never enters pin order logic', () => {
    expect(isGroupSentinel(intoFolderId('g_abc', 'focus'))).toBe(false);
    expect(isIntoFolderId(groupSortableId('g_abc', 'focus'))).toBe(false);
  });
});

describe('join-card target ids', () => {
  it('round-trips a card and a tier, custom tiers included', () => {
    for (const tier of ['focus', 'satellite', 'ct_12345678'] as const) {
      const id = joinCardId('mq9x2k-0007', tier);
      expect(isJoinCardId(id)).toBe(true);
      expect(parseJoinCardId(id)).toEqual({ taskId: 'mq9x2k-0007', tier });
    }
  });

  it('is never a chip, a folder target or pin order', () => {
    const id = joinCardId('t1', 'focus');
    expect(isGroupSentinel(id)).toBe(false);
    expect(isIntoFolderId(id)).toBe(false);
    expect(isJoinCardId(intoFolderId('g1', 'focus'))).toBe(false);
  });
});

// Project labels ride the sortable items (2026-09-30): a label left out stayed put
// while the rows around it slid, so a slot opened mid-drag was drawn under the wrong
// project and the drop then went somewhere the preview never showed.
describe('project label sentinels', () => {
  const proj: Record<string, string> = { a1: 'A', a2: 'A', b1: 'B', b2: 'B', i1: '' };
  const projectOf = (id: string) => proj[id];

  it('round-trips a project name that holds a colon, and Inbox', () => {
    expect(tierLabelProject(tierLabelId('focus', 'Ops: Alarms'))).toBe('Ops: Alarms');
    expect(tierLabelProject(tierLabelId('ct_1234', ''))).toBe('');
    expect(isTierLabelId(tierLabelId('focus', 'A'))).toBe(true);
    expect(isGroupSentinel(tierLabelId('focus', 'A'))).toBe(false);
  });

  it('opens each run with its label, a chip taking the project of the card it heads', () => {
    expect(withProjectLabels(['a1', 'group:g1:focus', 'b1', 'b2', 'i1'], 'focus', projectOf)).toEqual([
      'tierproj:focus:A', 'a1', 'tierproj:focus:B', 'group:g1:focus', 'b1', 'b2', 'tierproj:focus:', 'i1',
    ]);
  });

  it('is idempotent', () => {
    const once = withProjectLabels(['a1', 'a2', 'b1'], 'focus', projectOf);
    expect(withProjectLabels(once, 'focus', projectOf)).toEqual(once);
  });

  it('draws no label at all when fewer than two projects are visible', () => {
    const ids = ['tierproj:focus:A', 'a1', 'tierproj:focus:B', 'b1'];
    expect(pruneTierLabels(ids, new Set(['A']))).toEqual(['a1', 'b1']);
    expect(pruneTierLabels(ids, undefined)).toEqual(['a1', 'b1']);
  });

  it('drops only the label of a project with nothing visible, same array when nothing goes', () => {
    const ids = ['tierproj:focus:A', 'a1', 'tierproj:focus:B', 'b1', 'tierproj:focus:', 'i1'];
    expect(pruneTierLabels(ids, new Set(['A', '']))).toEqual(['tierproj:focus:A', 'a1', 'b1', 'tierproj:focus:', 'i1']);
    expect(pruneTierLabels(ids, new Set(['A', 'B', '']))).toBe(ids);
  });

  it('draws a folder under its first card\'s project, a card of another project inside included', () => {
    // Folder T (project A) holds t1 (A) and t2, which says B; subfolder M holds m1 (B).
    // b1 is project B's own loose card.
    const rows: Record<string, { project: string; group_id?: string }> = {
      a1: { project: 'A' }, t1: { project: 'A', group_id: 'T' }, t2: { project: 'B', group_id: 'T' },
      m1: { project: 'B', group_id: 'M' }, b1: { project: 'B' },
    };
    const parentOf = new Map([['M', 'T']]);
    const ids = ['a1', 't1', 't2', 'm1', 'b1'];
    const of = runProjectOf(ids, (id) => rows[id], parentOf);
    expect(['a1', 't1', 't2', 'm1', 'b1', 'group:T:focus'].map(of)).toEqual(['A', 'A', 'A', 'A', 'B', undefined]);
    const labelled = withProjectLabels(['a1', 'group:T:focus', 't1', 't2', 'group:M:focus', 'm1', 'b1'], 'focus', of);
    expect(labelled).toEqual([
      'tierproj:focus:A', 'a1', 'group:T:focus', 't1', 't2', 'group:M:focus', 'm1', 'tierproj:focus:B', 'b1',
    ]);
    expect(new Set(labelled).size).toBe(labelled.length);
    // Each card's own project instead: t2 opens a label B inside T, t1 a second A.
    const own = withProjectLabels(['a1', 'group:T:focus', 't2', 't1', 'b1'], 'focus', (id) => rows[id]?.project);
    expect(own.filter((id) => id === 'tierproj:focus:B')).toHaveLength(2);
    // With the run rule, that T leads with t2, so the whole folder is in run B, as the
    // project clustering keys it: one label per run again.
    expect(withProjectLabels(['a1', 'group:T:focus', 't2', 't1', 'b1'], 'focus', runProjectOf(['a1', 't2', 't1', 'b1'], (id) => rows[id], parentOf)))
      .toEqual(['tierproj:focus:A', 'a1', 'tierproj:focus:B', 'group:T:focus', 't2', 't1', 'b1']);
  });

  it('never reaches pin order, and a chip right before the next label is an orphan', () => {
    expect(taskIdsOnly(['tierproj:focus:A', 'a1', 'group:g1:focus', 'tierproj:focus:B', 'b1'])).toEqual(['a1', 'b1']);
    const tasks = [task('a1'), task('b1')];
    expect(pruneOrphanSentinels(['tierproj:focus:A', 'a1', 'group:g1:focus', 'tierproj:focus:B', 'b1'], byId(tasks), null))
      .toEqual(['tierproj:focus:A', 'a1', 'tierproj:focus:B', 'b1']);
  });
});

describe('slotFits: a slot opens only where the drop can stay', () => {
  // A tier drawn "By project": label A, loose a1 a2, folder T (own card t1) with
  // subfolder M (m1, m2), folder S (s1), label B, loose b1.
  const parentOf = new Map([['M', 'T']]);
  const folders: Record<string, string> = { t1: 'T', m1: 'M', m2: 'M', s1: 'S' };
  const rules = (mode: SlotRules['mode'] = 'project'): SlotRules => ({ folderOf: (id) => folders[id], parentOf, mode });
  const LA = tierLabelId('focus', 'A');
  const LB = tierLabelId('focus', 'B');
  const T = groupSortableId('T', 'focus');
  const M = groupSortableId('M', 'focus');
  const S = groupSortableId('S', 'focus');
  const board = [LA, 'a1', 'a2', T, 't1', M, 'm1', 'm2', S, 's1', LB, 'b1'];
  /** `board` without `moving`, with it put back right before `before` (undefined = the end). */
  const place = (moving: string[], before: string | undefined): [string[], number] => {
    const rest = board.filter((id) => !moving.includes(id));
    const at = before === undefined ? rest.length : rest.indexOf(before);
    rest.splice(at, 0, moving[0]);
    return [rest, at];
  };
  const fits = (moving: string[], before: string | undefined, mode?: SlotRules['mode']) => {
    const [arr, at] = place(moving, before);
    return slotFits(arr, at, rules(mode));
  };

  it('every card fits where it already is, and so does every folder (its subtree collapsed)', () => {
    for (let i = 0; i < board.length; i++) {
      if (isTierLabelId(board[i]) || isGroupSentinel(board[i])) continue;
      expect(slotFits(board, i, rules()), board[i]).toBe(true);
    }
    expect(fits([T, 't1', M, 'm1', 'm2'], S)).toBe(true);
    expect(fits([M, 'm1', 'm2'], S)).toBe(true);
    expect(fits([S, 's1'], LB)).toBe(true);
  });

  it('a top-level folder (dragged as its chip, subtree collapsed) goes between folders and runs only', () => {
    const subtreeOfS = [S, 's1'];
    expect(fits(subtreeOfS, T)).toBe(true); // above T
    expect(fits(subtreeOfS, LB)).toBe(true); // end of run A
    expect(fits(subtreeOfS, undefined)).toBe(true); // end of run B
    expect(fits(subtreeOfS, 't1')).toBe(false); // between T's chip and its card
    expect(fits(subtreeOfS, 'm2')).toBe(false); // inside the subfolder
    expect(fits(subtreeOfS, 'a2')).toBe(false); // among the loose cards, By project
    expect(fits(subtreeOfS, 'a2', 'custom')).toBe(true); // which a custom order allows
    expect(fits(subtreeOfS, 'b1')).toBe(false); // right under label B, above its loose card
  });

  it('a subfolder stays inside its parent, after the parent\'s own cards', () => {
    const subtreeOfM = [M, 'm1', 'm2'];
    expect(fits(subtreeOfM, S)).toBe(true); // last thing in T
    expect(fits(subtreeOfM, 't1')).toBe(false); // above T's own card
    expect(fits(subtreeOfM, T)).toBe(false); // out of T
    expect(fits(subtreeOfM, LB)).toBe(false);
  });

  it('a member card stays among its folder\'s own cards, or leaves to a loose place', () => {
    expect(fits(['m2'], 'm1')).toBe(true); // reorder inside M
    expect(fits(['m2'], S)).toBe(true); // after m1, still in M
    expect(fits(['t1'], M)).toBe(true); // T's own zone ends at its subfolder
    expect(fits(['m2'], 't1')).toBe(false); // into T's own zone: that is another folder
    expect(fits(['m2'], 'a2')).toBe(true); // out, among the loose cards
    expect(fits(['m2'], T)).toBe(true); // out, the last loose card of run A
    expect(fits(['m2'], LB)).toBe(false); // out, but below a folder, By project
    expect(fits(['m2'], LB, 'custom')).toBe(true);
  });

  it('a loose card never lands inside a folder, nor below one By project', () => {
    expect(fits(['a1'], T)).toBe(true);
    expect(fits(['a1'], 't1')).toBe(false);
    expect(fits(['a1'], S)).toBe(false); // between two folders
    expect(fits(['a1'], S, 'custom')).toBe(true);
    expect(fits(['a1'], 'b1')).toBe(true); // into run B's loose cards
    expect(fits(['a1'], undefined)).toBe(true);
  });

  it('nothing goes above the first project label, where no run would keep it', () => {
    expect(fits(['b1'], LA)).toBe(false);
    expect(fits(['m2'], LA)).toBe(false);
    expect(fits([S, 's1'], LA)).toBe(false);
    expect(fits(['b1'], 'a1')).toBe(true); // right under label A: run A's first card
    expect(slotFits(['a1', 'a2'], 0, rules())).toBe(true); // a tier without labels
  });

  it('a subfolder stays inside its parent in a custom order too, and a loose card stays out of folders', () => {
    const subtreeOfM = [M, 'm1', 'm2'];
    expect(fits(subtreeOfM, S, 'custom')).toBe(true);
    expect(fits(subtreeOfM, 'a2', 'custom')).toBe(false); // among the loose cards: out of T
    expect(fits(subtreeOfM, T, 'custom')).toBe(false);
    expect(fits(subtreeOfM, 't1', 'custom')).toBe(false); // above T's own card
    expect(fits(['a1'], 't1', 'custom')).toBe(false);
    expect(fits(['a1'], 'm2', 'custom')).toBe(false);
  });

  it('looks through divider lines', () => {
    const arr = ['a1', 'sep_x', 'a2', T, 't1'];
    expect(slotFits(arr, 2, { folderOf: (id) => folders[id], mode: 'custom' })).toBe(true);
    const lined = ['a1', T, 'sep_y', 't1'];
    expect(slotFits(lined, 3, { folderOf: (id) => folders[id], mode: 'custom' })).toBe(true);
  });
});

describe('staysInFolder: a member\'s drop keeps it in its folder', () => {
  const folders: Record<string, string> = { t1: 'T', t2: 'T', s1: 'S' };
  const folderOf = (id: string) => folders[id];
  const T = groupSortableId('T', 'focus');
  const S = groupSortableId('S', 'focus');

  it('right below its folder\'s chip or one of its own cards', () => {
    expect(staysInFolder([T, 't2', 't1'], 1, folderOf)).toBe(true);
    expect(staysInFolder([T, 't1', 't2'], 2, folderOf)).toBe(true);
  });

  it('anywhere else takes it out: below another folder, a loose card, a label, or at the top', () => {
    expect(staysInFolder([S, 's1', 't1'], 2, folderOf)).toBe(false);
    expect(staysInFolder([S, 't1', 's1'], 1, folderOf)).toBe(false);
    expect(staysInFolder(['a1', 't1'], 1, folderOf)).toBe(false);
    expect(staysInFolder([tierLabelId('focus', 'A'), 't1'], 1, folderOf)).toBe(false);
    expect(staysInFolder(['t1', T, 't2'], 0, folderOf)).toBe(false);
  });

  it('looks through divider lines, and never answers for a loose card or a chip', () => {
    expect(staysInFolder([T, 'sep_x', 't1'], 2, folderOf)).toBe(true);
    expect(staysInFolder([T, 'a1'], 1, folderOf)).toBe(false);
    expect(staysInFolder(['t1', S], 1, folderOf)).toBe(false);
  });
});
