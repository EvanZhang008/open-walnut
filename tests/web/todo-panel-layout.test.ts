import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const TODO_PANEL_SRC = fs.readFileSync(
  path.resolve(import.meta.dirname, '../../web/src/components/tasks/TodoPanel.tsx'),
  'utf8'
);
const CSS_SRC = fs.readFileSync(
  path.resolve(import.meta.dirname, '../../web/src/styles/globals.css'),
  'utf8'
);
const FOCUS_CARDS_SRC = fs.readFileSync(
  path.resolve(import.meta.dirname, '../../web/src/components/tasks/FocusSatelliteCards.tsx'),
  'utf8'
);
const TASK_CARD_SRC = fs.readFileSync(
  path.resolve(import.meta.dirname, '../../web/src/components/tasks/TaskCard.tsx'),
  'utf8'
);
const SESSION_PILL_SRC = fs.readFileSync(
  path.resolve(import.meta.dirname, '../../web/src/components/tasks/SessionPill.tsx'),
  'utf8'
);

describe('TodoPanel layout: task controls preserve title space', () => {
  it('keeps the title row controls inside todo-item-content', () => {
    const contentIdx = TODO_PANEL_SRC.indexOf('"todo-item-content"');
    const titleRowIdx = TODO_PANEL_SRC.indexOf('"todo-item-title-row"', contentIdx);
    const kebabIdx = TODO_PANEL_SRC.indexOf('<TaskKebabMenu', titleRowIdx);
    const metaRowIdx = TODO_PANEL_SRC.indexOf('"todo-item-meta-row"', kebabIdx);
    expect(contentIdx).toBeGreaterThan(-1);
    expect(titleRowIdx).toBeGreaterThan(contentIdx);
    expect(kebabIdx).toBeGreaterThan(titleRowIdx);
    expect(metaRowIdx).toBeGreaterThan(kebabIdx);
  });

  it('keeps the phase status control in the title row, not the search meta row', () => {
    const titleRowIdx = TODO_PANEL_SRC.indexOf('"todo-item-title-row"');
    const phaseStatusIdx = TODO_PANEL_SRC.indexOf('className={`task-phase-icon-btn', titleRowIdx);
    const metaRowIdx = TODO_PANEL_SRC.indexOf('"todo-item-meta-row"');
    const ordinaryItemEnd = TODO_PANEL_SRC.indexOf('// ── Static task item', metaRowIdx);
    expect(phaseStatusIdx).toBeGreaterThan(titleRowIdx);
    expect(metaRowIdx).toBeGreaterThan(phaseStatusIdx);
    expect(TODO_PANEL_SRC.slice(metaRowIdx, ordinaryItemEnd))
      .not.toContain('className={`task-phase-icon-btn');
  });

  it('CSS lets task content and titles consume the available row width', () => {
    const contentStart = CSS_SRC.indexOf('.todo-item-content {');
    const content = CSS_SRC.slice(contentStart, CSS_SRC.indexOf('}', contentStart) + 1);
    const titleStart = CSS_SRC.indexOf('\n.todo-item-title {') + 1;
    const title = CSS_SRC.slice(titleStart, CSS_SRC.indexOf('}', titleStart) + 1);
    expect(content).toContain('flex: 1');
    expect(content).toContain('min-width: 0');
    expect(content).toContain('display: flex');
    expect(title).toContain('flex: 1');
    expect(title).toContain('min-width: 0');
  });
});

describe('Task linked-session pill visibility', () => {
  it('keeps linked-session pills off Home while preserving the dedicated tasks card', () => {
    expect(SESSION_PILL_SRC).toContain('export function TaskSessionPill');
    expect(SESSION_PILL_SRC).toContain('resolveTaskSessionId(task)');
    expect(TODO_PANEL_SRC).not.toContain('<TaskSessionPill');
    expect(FOCUS_CARDS_SRC).not.toContain('<TaskSessionPill');
    expect(TASK_CARD_SRC.match(/<TaskSessionPill/g)).toHaveLength(1);
  });

  it('the shared wrapper preserves tasks without linked sessions', () => {
    expect(SESSION_PILL_SRC).toMatch(
      /const sessionId = resolveTaskSessionId\(task\);[\s\S]*if \(!sessionId\) return null;/,
    );
  });

  it('has no Home-only session pill placement rules', () => {
    expect(CSS_SRC).not.toContain('.todo-pinned-card-content .task-session-pill {');
    expect(CSS_SRC).not.toContain('.todo-item-content > .task-session-pill {');
  });
});
