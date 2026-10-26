import { describe, expect, it } from 'vitest';
import {
  MAIN_QUICK_ACTIONS, quickActionMessage, quickActionsFor,
} from '../../web/src/components/org/main-quick-actions';

describe('Main quick actions', () => {
  it('every message asks for a list first and changes nothing until the user picks', () => {
    for (const a of MAIN_QUICK_ACTIONS) {
      const text = quickActionMessage(a.id);
      expect(text.startsWith('Quick action: ')).toBe(true);
      expect(text).toContain('read calls only: do not message, create, start or edit any task or project until I answer');
      expect(text).toContain('numbered list');
      expect(text).toContain('apply exactly those');
      expect(text).toContain('Leave Main, the project leads and the Ask projects where they are.');
      expect(text).not.toContain('Only look at');
    }
  });

  it('each action asks for its own kind of cleanup', () => {
    expect(quickActionMessage('projects')).toMatch(/merge[\s\S]*rename[\s\S]*remove/);
    expect(quickActionMessage('place')).toContain('wrong project or folder');
    expect(quickActionMessage('triage')).toContain('walnut-triage');
    expect(quickActionMessage('triage')).toMatch(/stale[\s\S]*duplicates[\s\S]*done but still open/);
  });

  it('a project scope narrows place and triage, and the Inbox has its own words', () => {
    // Unicode project name (CJK test data).
    const name = 'Marina \u5de5\u4f5c';
    expect(quickActionMessage('triage', { project: name })).toContain(`Only look at the project "${name}".`);
    expect(quickActionMessage('place', { project: '' })).toContain('Only look at the Inbox (tasks with no project).');
    // Merging projects is about all of them: a scope does not narrow it.
    expect(quickActionMessage('projects', { project: name })).not.toContain('Only look at');
  });

  it('one project offers no project merge', () => {
    expect(quickActionsFor().map((a) => a.id)).toEqual(['projects', 'place', 'triage']);
    expect(quickActionsFor({ project: 'Walnut' }).map((a) => a.id)).toEqual(['place', 'triage']);
    expect(quickActionsFor({ project: '' }).map((a) => a.id)).toEqual(['place', 'triage']);
  });
});
