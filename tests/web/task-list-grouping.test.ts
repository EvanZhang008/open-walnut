/**
 * Guards the virtual-group wiring on the /tasks page (TaskList / TaskCard).
 *
 * The /tasks list is a SEPARATE component tree from the home Todo panel
 * (DashboardPage → TaskList → TaskCard), so the grouping treatment has to be wired
 * in twice. These are source-level assertions (web components can't be imported in
 * the node vitest env — same approach as todo-panel-layout.test.ts). Each would fail
 * if the corresponding piece of the grouping feature regressed out of TaskList.
 *
 * 2026-07-26: 2 of these 8 tests had rotted (the ≥2 group threshold became ≥1, and
 * the same-lane scope gate was removed). The whole file was briefly deleted
 * as "a source-text test that proves nothing" — restored instead, because the other
 * 6 are the ONLY coverage of the /tasks-page grouping wiring (App.tsx routes /tasks
 * → DashboardPage → TaskList), and the two stale ones just needed re-pointing at the
 * current rules. A source-text guard is a weak test, but weak beats absent for
 * frontend wiring that the node test env cannot render.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const TASK_LIST_SRC = fs.readFileSync(
  path.resolve(import.meta.dirname, '../../web/src/components/tasks/TaskList.tsx'),
  'utf8',
);
const TASK_CARD_SRC = fs.readFileSync(
  path.resolve(import.meta.dirname, '../../web/src/components/tasks/TaskCard.tsx'),
  'utf8',
);
const DASHBOARD_SRC = fs.readFileSync(
  path.resolve(import.meta.dirname, '../../web/src/pages/DashboardPage.tsx'),
  'utf8',
);
const CSS_SRC = fs.readFileSync(
  path.resolve(import.meta.dirname, '../../web/src/styles/globals.css'),
  'utf8',
);

describe('TaskList grouping wiring', () => {
  it('clusters group members contiguously before rendering each lane', () => {
    // Project is the single grouping layer, so there is ONE lane per project
    // ('' = Inbox) and it must be clustered, otherwise members would scatter and
    // the rail/chip would not be contiguous.
    expect(TASK_LIST_SRC).toContain('function clusterByGroup');
    expect(TASK_LIST_SRC).toMatch(/clusterByGroup\(projTasks\)/);
  });

  it('counts group members from the DISPLAYED lane set', () => {
    // The chip+rail count must be derived from each lane, not from the unfiltered
    // task list, so a filtered-out member never leaves a broken-looking group.
    const mapIdx = TASK_LIST_SRC.indexOf('groupRenderMap');
    expect(mapIdx).toBeGreaterThan(-1);
    expect(TASK_LIST_SRC).toMatch(/for \(const t of lane\) if \(t\.group_id\)/);
    // Threshold is `< 1` (drop groups with no visible member). It was `< 2` when
    // this test was written; the product deliberately relaxed it so a group whose
    // siblings are filtered out still renders its remaining member.
    expect(TASK_LIST_SRC).toMatch(/counts\.get\(gid\) \?\? 0\) < 1/);
  });

  it('gates the Group button on the selection size, not on a shared lane', () => {
    // The old rule required every selected task to share its grouping scope
    // (`sameScope`). That was dropped — grouping across lanes is now allowed — so
    // the only gate is "at least 2 selected". Assert the rule's ABSENCE too, so
    // silently reinstating a same-project restriction fails here.
    expect(TASK_LIST_SRC).not.toMatch(/t\.project === project/);
    expect(TASK_LIST_SRC).toMatch(/canGroup:\s*picked\.length >= 2/);
    expect(TASK_LIST_SRC).toContain('disabled={!selectionInfo.canGroup}');
  });

  it('builds a multi-selection via modifier-click and a floating Group bar', () => {
    expect(TASK_LIST_SRC).toContain('task-selection-bar');
    expect(TASK_LIST_SRC).toContain('task-selection-group-btn');
    expect(TASK_LIST_SRC).toContain('onGroupTasks(selectionInfo.tasks.map');
    // Selection toggle is only enabled when grouping is wired (onGroupTasks present).
    expect(TASK_LIST_SRC).toContain('onSelectToggle={onGroupTasks ? onSelectToggle : undefined}');
  });

  it('TaskCard renders the group chip on the lead and the rail on every member', () => {
    expect(TASK_CARD_SRC).toContain('task-group-chip');
    expect(TASK_CARD_SRC).toMatch(/groupInfo \? 'task-grouped' : ''/);
    expect(TASK_CARD_SRC).toMatch(/groupInfo\?\.isLead \? 'task-group-lead' : ''/);
    expect(TASK_CARD_SRC).toMatch(/groupInfo\?\.isLast \? 'task-group-last' : ''/);
  });

  it('TaskCard modifier-click toggles selection instead of navigating', () => {
    expect(TASK_CARD_SRC).toMatch(/e\.metaKey \|\| e\.ctrlKey \|\| e\.shiftKey/);
    expect(TASK_CARD_SRC).toContain('onSelectToggle(task.id)');
  });

  it('DashboardPage passes the group context down to TaskList', () => {
    expect(DASHBOARD_SRC).toMatch(/taskGroups,\s*groupTasks,\s*ungroupTasks,\s*renameGroup/);
    expect(DASHBOARD_SRC).toContain('onGroupTasks={groupTasks}');
    expect(DASHBOARD_SRC).toContain('onUngroupTask={(taskId) => ungroupTasks([taskId])}');
    expect(DASHBOARD_SRC).toContain('onRenameGroup={renameGroup}');
  });

  it('CSS shares the rail/selection styles between the panel and the /tasks card', () => {
    // The grouping styles must target .task-card too, not only .todo-panel-item.
    expect(CSS_SRC).toMatch(/\.task-card\.task-grouped/);
    expect(CSS_SRC).toMatch(/\.task-card\.task-multi-selected/);
  });
});
