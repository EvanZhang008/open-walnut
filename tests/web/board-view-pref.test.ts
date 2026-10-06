/**
 * The Board view pick (board-view-pref.ts): Projects | Cards | Page. With no
 * pick, or one the board cannot show, Projects when the leader defined
 * projects, else Cards; a pick is kept per owner and comes back once the board
 * can show it; the stored 'overview' of before the kanban named the project
 * board, so it reads as Projects.
 */
import { describe, expect, it } from 'vitest';
import {
  BOARD_VIEW_PREFIX, defaultBoardView, parseBoardView, readBoardView, shownBoardView, writeBoardView,
} from '../../web/src/components/board/board-view-pref';
import { keepIfSame, NO_PROJECTS, projectsOfTeam } from '../../web/src/components/board/board-view-projects';
import type { OverviewSection, PlacedRow } from '../../web/src/components/board/board-overview-model';

function memStorage(blocked = false) {
  const m = new Map<string, string>();
  return {
    m,
    getItem: (k: string) => { if (blocked) throw new Error('blocked'); return m.get(k) ?? null; },
    setItem: (k: string, v: string) => { if (blocked) throw new Error('blocked'); m.set(k, v); },
  };
}

describe('board view pref: Projects | Cards | Page', () => {
  it('defaults to Projects when the board has projects, else Cards', () => {
    expect(defaultBoardView(true)).toBe('projects');
    expect(defaultBoardView(false)).toBe('cards');
    expect(shownBoardView(null, true, true)).toBe('projects');
    expect(shownBoardView(null, true, false)).toBe('cards');
  });

  it('shows a pick only while the board can show it, and falls back to the default', () => {
    expect(shownBoardView('custom', true, false)).toBe('custom');
    expect(shownBoardView('custom', false, false)).toBe('cards');
    expect(shownBoardView('custom', false, true)).toBe('projects');
    expect(shownBoardView('projects', true, true)).toBe('projects');
    expect(shownBoardView('projects', true, false)).toBe('cards');
    expect(shownBoardView('cards', true, true)).toBe('cards');
    expect(shownBoardView('cards', false, false)).toBe('cards');
  });

  it('reads the stored values, the old Overview as Projects, anything else as no pick', () => {
    expect(parseBoardView('projects')).toBe('projects');
    expect(parseBoardView('cards')).toBe('cards');
    expect(parseBoardView('custom')).toBe('custom');
    expect(parseBoardView('overview')).toBe('projects');
    expect(parseBoardView('kanban')).toBeNull();
    expect(parseBoardView(null)).toBeNull();
  });

  it('keeps one pick per owner, under the same key as before', () => {
    const s = memStorage();
    writeBoardView(s, 'lead-a', 'cards');
    writeBoardView(s, 'lead-b', 'custom');
    expect(s.m.get(`${BOARD_VIEW_PREFIX}lead-a`)).toBe('cards');
    expect(readBoardView(s, 'lead-a')).toBe('cards');
    expect(readBoardView(s, 'lead-b')).toBe('custom');
    expect(readBoardView(s, 'lead-c')).toBeNull();
    s.m.set(`${BOARD_VIEW_PREFIX}lead-d`, 'overview');
    expect(readBoardView(s, 'lead-d')).toBe('projects');
  });

  it('a blocked storage never throws', () => {
    const s = memStorage(true);
    expect(() => writeBoardView(s, 'lead', 'cards')).not.toThrow();
    expect(readBoardView(s, 'lead')).toBeNull();
    expect(readBoardView(null, 'lead')).toBeNull();
    expect(readBoardView(memStorage(), '')).toBeNull();
  });
});

describe('projectsOfTeam: each card\'s project, as the Projects view places it', () => {
  const row = (id: string) => ({ id } as unknown as PlacedRow);
  const section = (kind: OverviewSection['kind'], id: string, title: string, rows: string[]): OverviewSection => ({
    kind, id, title, status: kind === 'project' ? 'wip' : null, rows: rows.map(row), attention: 0, done: 0,
  });

  it('maps every row of a project section to that project, and nothing for the rest', () => {
    const m = projectsOfTeam([
      section('project', 'dns', 'DNS timeouts', ['t1', 't2']),
      section('project', 'quota', 'Quota alarms', ['t3']),
      section('rest', '_rest', 'Other tasks', ['t4']),
    ]);
    expect(m.get('t1')).toEqual({ id: 'dns', title: 'DNS timeouts', status: 'wip' });
    expect(m.get('t3')?.id).toBe('quota');
    expect(m.has('t4')).toBe(false);
  });

  it('the first project naming a task keeps it; no sections is an empty map', () => {
    const m = projectsOfTeam([section('project', 'a', 'A', ['t1']), section('project', 'b', 'B', ['t1'])]);
    expect(m.get('t1')?.id).toBe('a');
    expect(projectsOfTeam(null).size).toBe(0);
    expect(projectsOfTeam([section('rest', '_rest', 'Other tasks', ['t1'])]).size).toBe(0);
  });

  it('keepIfSame keeps the old map while every card keeps its project, so a status push re-renders no card', () => {
    const before = projectsOfTeam([section('project', 'dns', 'DNS timeouts', ['t1', 't2'])]);
    const rebuilt = projectsOfTeam([section('project', 'dns', 'DNS timeouts', ['t1', 't2'])]);
    expect(rebuilt).not.toBe(before);
    expect(keepIfSame(before, rebuilt)).toBe(before);
    const renamed = projectsOfTeam([section('project', 'dns', 'DNS timeouts (resolver)', ['t1', 't2'])]);
    expect(keepIfSame(before, renamed)).toBe(renamed);
    const moved = projectsOfTeam([section('project', 'dns', 'DNS timeouts', ['t1']), section('project', 'q', 'Quota', ['t2'])]);
    expect(keepIfSame(before, moved)).toBe(moved);
    const grown = projectsOfTeam([section('project', 'dns', 'DNS timeouts', ['t1', 't2', 't3'])]);
    expect(keepIfSame(before, grown)).toBe(grown);
    const done = projectsOfTeam([{ ...section('project', 'dns', 'DNS timeouts', ['t1', 't2']), status: 'done' }]);
    expect(keepIfSame(before, done)).toBe(done);
    expect(keepIfSame(before, NO_PROJECTS)).toBe(NO_PROJECTS);
  });
});
