/**
 * Source ratchet for the lean task kebab (2026-09-10). The browser spec
 * (tests/e2e/browser/kebab-menu-lean.spec.ts) proves the menu a user sees; this
 * pins the STRUCTURE that keeps the two kebabs from drifting apart again:
 *
 *  . the session panel's kebab (TaskQuickActions) renders the shared block
 *    (TaskActionMenuItems) instead of its own copy of tier / priority / dates,
 *    which is how the two menus had already diverged once (an "Unpin" row and a
 *    "Mark unread" row that the board kebab never had);
 *  . neither kebab has a standalone Unpin row or an unread row;
 *  . priority in the shared block is gated on the `ui.show_priority` hook;
 *  . dates render through the collapsed KebabDateRow, never a bare inline picker.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const read = (rel: string) => fs.readFileSync(path.resolve(import.meta.dirname, '../../web/src', rel), 'utf8');

const KEBAB = read('components/tasks/TaskKebabMenu.tsx');
const QUICK = read('components/sessions/TaskQuickActions.tsx');
const CSS = read('styles/globals.css');

describe('task kebab menus stay lean and shared', () => {
  it('the session-panel kebab renders the shared action block, not its own copy', () => {
    expect(QUICK).toContain('<TaskActionMenuItems');
    expect(QUICK).not.toContain('task-kebab-tier-options');
    expect(QUICK).not.toContain('task-kebab-priority');
    expect(QUICK).not.toContain('<DatePicker');
  });

  it('no standalone Unpin row anywhere: the lit tier pill unpins', () => {
    expect(KEBAB).not.toMatch(/<span>Unpin<\/span>/);
    expect(QUICK).not.toMatch(/<span>Unpin<\/span>/);
    // The pill click path routes the active tier to onUnpinTask.
    expect(KEBAB).toMatch(/if \(isCurrent\) onUnpinTask\?\.\(\)/);
  });

  it('no unread row in either kebab', () => {
    expect(KEBAB).not.toContain('open to mark read');
    expect(QUICK).not.toContain('Mark unread');
    expect(QUICK).not.toContain('handleToggleUnread');
  });

  it('priority in the shared block is gated on the show-priority setting', () => {
    expect(KEBAB).toContain("from '@/hooks/useShowPriority'");
    expect(KEBAB).toMatch(/\{onSetPriority && showPriority && \(/);
  });

  it('dates are collapsed rows with the calendar behind a click', () => {
    expect(KEBAB).toContain('export function KebabDateRow');
    expect(KEBAB).toMatch(/\{open && <DatePicker/);
    // Both date fields go through the row; no bare inline picker remains in the block.
    const block = KEBAB.slice(KEBAB.indexOf('export function TaskActionMenuItems'), KEBAB.indexOf('export function ProjectPickerFlyout'));
    expect(block).not.toContain('<DatePicker');
    expect((block.match(/<KebabDateRow/g) ?? []).length).toBe(2);
    expect(CSS).toContain('.task-kebab-date-toggle');
  });
});
