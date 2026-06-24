/**
 * Guards the virtual-group wiring on the /tasks page (TaskList / TaskCard).
 *
 * The /tasks list is a SEPARATE component tree from the home Todo panel
 * (DashboardPage → TaskList → TaskCard), so the grouping treatment has to be wired
 * in twice. These are source-level assertions (web components can't be imported in
 * the node vitest env — same approach as todo-panel-layout.test.ts). Each would fail
 * if the corresponding piece of the grouping feature regressed out of TaskList.
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
    // Both the no-project (direct) lane and each project lane must be clustered,
    // otherwise members would scatter and the rail/chip would not be contiguous.
    expect(TASK_LIST_SRC).toContain('function clusterByGroup');
    expect(TASK_LIST_SRC).toMatch(/directTasks:\s*clusterByGroup\(direct\)/);
    expect(TASK_LIST_SRC).toMatch(/clusterByGroup\(projTasks\)/);
  });

  it('counts group members from the DISPLAYED lane set (≥2 to box)', () => {
    // The chip+rail must require ≥2 *visible* members — derived from each lane, not
    // from the unfiltered task list — so a lone survivor never shows a broken group.
    const mapIdx = TASK_LIST_SRC.indexOf('groupRenderMap');
    expect(mapIdx).toBeGreaterThan(-1);
    expect(TASK_LIST_SRC).toMatch(/for \(const t of lane\) if \(t\.group_id\)/);
    expect(TASK_LIST_SRC).toMatch(/counts\.get\(gid\) \?\? 0\) < 2/);
  });

  it('enforces the same category+project scope rule before enabling Group', () => {
    expect(TASK_LIST_SRC).toMatch(/t\.category === category && t\.project === project/);
    expect(TASK_LIST_SRC).toContain('disabled={!selectionInfo.sameScope}');
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
