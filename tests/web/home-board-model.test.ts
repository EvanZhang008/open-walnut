import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { Task } from '@open-walnut/core';
import { boardFamilyIds, boardMoveIds, buildHomeBoard } from '../../web/src/components/tasks/home-board-model';

function task(id: string, fields: Partial<Task> = {}): Task {
  return { id, title: id, project: 'Project A', phase: 'TODO', status: 'todo', source: 'local', priority: 'none', created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-01T00:00:00Z', ...fields } as Task;
}
const tier = (tasks: Task[], id: string) => buildHomeBoard(tasks, [], 'pin').find(c => c.id === id)!;

describe('Home board grouping', () => {
  it('keeps every shared task-settings flyout out of the glass layer', () => {
    const picker = fs.readFileSync(path.resolve(__dirname, '../../web/src/components/tasks/CursorFlyout.tsx'), 'utf8');
    const glass = fs.readFileSync(path.resolve(__dirname, '../../web/src/styles/overlay-glass.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const portals = [...picker.matchAll(/createPortal\([\s\S]*?className="([\w-]+)"/g)].map(m => m[1]);
    expect(portals).toContain('task-kebab-project-flyout');
    for (const name of portals) expect(glass).not.toContain(`.${name}`);
  });
  it('uses the column body for vertical scrolling and keeps its header static', () => {
    const css = fs.readFileSync(path.resolve(__dirname, '../../web/src/styles/home-board.css'), 'utf8');
    const rule = (name: string) => css.match(new RegExp(`\\.${name} \\{([^}]+)\\}`))![1];
    expect(rule('home-board-columns')).not.toContain('contain: layout');
    expect(rule('home-board-column')).not.toContain('overflow-y: auto');
    expect(rule('home-board-column')).not.toContain('contain: paint');
    expect(rule('home-board-column-head')).not.toContain('position: sticky');
    expect(rule('home-board-column-body')).toContain('overflow-y: auto');
    expect(css).not.toMatch(/translateZ|will-change/);
    expect(rule('home-board-drag-preview')).toContain('width: 100%');
    expect(rule('home-board-drag-preview')).toContain('box-sizing: border-box');
    const sheet = fs.readFileSync(path.resolve(__dirname, '../../web/src/components/tasks/HomeBoardSheet.tsx'), 'utf8');
    expect(sheet).not.toContain('scrollIntoView');
    expect(sheet).toContain("column.querySelector<HTMLElement>('.home-board-column-body')");
    expect(sheet).toContain('Math.max(bodyBox.top, header.getBoundingClientRect().bottom) + 8');
    expect(sheet).toContain('bodyBox.bottom - 8');
    expect(sheet).toContain('body.scrollTop');
    expect(sheet).not.toContain('column.scrollTop');
    expect(sheet).toContain('strip.scrollLeft');
    expect(sheet).toContain("pointerEvents: 'none'");
  });
  it('groups pin columns by project and nests every depth once', () => {
    const tasks = [task('leader', { pinned: true, focus_tier: 'focus' }), task('child', { pinned: true, focus_tier: 'focus', parent_task_id: 'leader' }), task('grandchild', { pinned: true, focus_tier: 'focus', parent_task_id: 'child' }), task('other', { project: 'Project B', pinned: true, focus_tier: 'focus' })];
    const column = tier(tasks, 'focus');
    expect(column.count).toBe(4);
    expect(column.projects.map(p => [p.label, p.count])).toEqual([['Project A', 3], ['Project B', 1]]);
    expect(boardFamilyIds(column.projects[0].families[0])).toEqual(['leader', 'child', 'grandchild']);
  });

  it('keeps cross-tier and cross-project children where the user put them', () => {
    const tasks = [task('leader', { pinned: true, focus_tier: 'focus' }), task('moved', { parent_task_id: 'leader', pinned: true }), task('elsewhere', { parent_task_id: 'leader', project: 'Other', pinned: true, focus_tier: 'focus' })];
    expect(tier(tasks, 'focus').projects.flatMap(p => p.families).map(f => f.task.id)).toEqual(['elsewhere', 'leader']);
    expect(tier(tasks, 'satellite').projects[0].families[0].parent?.id).toBe('leader');
  });

  it('moves same-tier descendants across projects without overriding separate tiers or completed work', () => {
    const rows = [task('leader', { pinned: true, focus_tier: 'focus' }), task('child', { pinned: true, focus_tier: 'focus', project: 'Other', parent_task_id: 'leader' }), task('grandchild', { pinned: true, focus_tier: 'focus', parent_task_id: 'child' }), task('separate', { pinned: true, parent_task_id: 'leader' }), task('done', { pinned: true, focus_tier: 'focus', phase: 'COMPLETE', status: 'done', parent_task_id: 'leader' }), task('hidden', { pinned: true, focus_tier: 'focus', plugin_only: 'plugin', parent_task_id: 'leader' })];
    expect(boardMoveIds(rows, rows[0], [])).toEqual(['leader', 'child', 'grandchild']);
    expect(boardMoveIds([task('a', { parent_task_id: 'b' }), task('b', { parent_task_id: 'a' })], task('a'), [])).toEqual(['a', 'b']);
  });

  it('uses the shared status including read and snoozed work, not a new phase map', () => {
    const rows = [task('read', { user_status: { state: 'read' } as Task['user_status'] }), task('snoozed', { phase: 'NEED_ACTION', user_status: { state: 'waiting', snoozed: true } as Task['user_status'] }), task('working', { user_status: { state: 'working' } as Task['user_status'] }), task('done', { phase: 'COMPLETE', status: 'done' })];
    const columns = buildHomeBoard(rows, [], 'status');
    expect(columns.map(c => [c.id, c.count])).toEqual([['needs', 1], ['working', 1], ['waiting', 1], ['done', 1]]);
  });

  it('offers empty custom tiers, Inbox and unpinned, but no hidden org or plugin tasks', () => {
    const columns = buildHomeBoard([task('inbox', { project: '' }), task('hidden', { plugin_only: 'plugin' }), task('vp', { org_role: 'lead' })], [{ id: 'ct_test', label: 'Release' }], 'pin');
    expect(columns.map(c => c.id)).toEqual(['focus', 'satellite', 'ct_test', 'unpinned']);
    expect(columns.find(c => c.id === 'ct_test')?.count).toBe(0);
    expect(columns.at(-1)?.projects[0].label).toBe('Inbox');
    expect(columns.at(-1)?.count).toBe(1);
  });

  it('finds Unicode child titles and includes their leader as context, without duplicate cards', () => {
    const rows = [task('parent-123', { pinned: true }), task('child', { title: `${String.fromCodePoint(0x5199, 0x4f5c)} practice`, pinned: true, parent_task_id: 'parent' })];
    const column = buildHomeBoard(rows, [], 'pin', String.fromCodePoint(0x5199, 0x4f5c))[1];
    expect(column.count).toBe(2);
    expect(boardFamilyIds(column.projects[0].families[0])).toEqual(['parent-123', 'child']);
  });

  it('stops search context at a completed parent', () => {
    const rows = [task('ancestor', { pinned: true }), task('parent', { pinned: true, phase: 'COMPLETE', status: 'done', parent_task_id: 'ancestor' }), task('child', { pinned: true, parent_task_id: 'parent' })];
    const column = buildHomeBoard(rows, [], 'pin', 'child')[1];
    expect(column.projects[0].families.flatMap(boardFamilyIds)).toEqual(['child']);
  });

  it('caps done cards, not the count, and search reaches older completed work', () => {
    const rows = Array.from({ length: 50 }, (_, i) => task(`done-${i}`, { phase: 'COMPLETE', status: 'done', updated_at: `2026-11-01T00:00:${String(i).padStart(2, '0')}Z` }));
    const done = buildHomeBoard(rows, [], 'status').at(-1)!;
    expect(done.count).toBe(50);
    expect(done.projects.flatMap(p => p.families)).toHaveLength(30);
    expect(buildHomeBoard(rows, [], 'status', 'done-0').at(-1)?.projects[0].families[0].task.id).toBe('done-0');
  });

  it('never loses tasks in corrupt parent cycles or missing parents', () => {
    const rows = [task('a', { parent_task_id: 'b' }), task('b', { parent_task_id: 'a' }), task('orphan', { parent_task_id: 'gone' })];
    const column = tier(rows, 'unpinned');
    expect(column.projects[0].families.flatMap(boardFamilyIds).sort()).toEqual(['a', 'b', 'orphan']);
  });
});
