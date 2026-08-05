import { describe, it, expect } from 'vitest';
import {
  parseProjectFromListName,
  routePulledListToProject,
  isRetiredQuickStartGroup,
  isLegacyInboxGroup,
} from '../../src/utils/format.js';

describe('parseProjectFromListName', () => {
  it('takes the trailing segment of a legacy "Category / Project" list name', () => {
    expect(parseProjectFromListName('Work / VPA')).toBe('VPA');
  });

  it('title-cases a lowercase trailing segment', () => {
    expect(parseProjectFromListName('us / ca')).toBe('Ca');
  });

  it('title-cases a plain list name (the new, project-named list)', () => {
    expect(parseProjectFromListName('personal')).toBe('Personal');
  });

  it('handles empty string', () => {
    expect(parseProjectFromListName('')).toBe('');
  });

  it('splits on the FIRST separator only — later " / " stays in the project name', () => {
    expect(parseProjectFromListName('A / B / C')).toBe('B / C');
  });

  it('a slash without surrounding spaces is not a separator', () => {
    expect(parseProjectFromListName('work/vpa')).toBe('Work/vpa');
  });

  it('a slash-space without a leading space is not a separator', () => {
    expect(parseProjectFromListName('work/ vpa')).toBe('Work/ vpa');
  });

  it('handles CJK names with no separator', () => {
    expect(parseProjectFromListName('任务')).toBe('任务');
  });

  it('handles CJK names with a separator', () => {
    expect(parseProjectFromListName('工作 / 项目A')).toBe('项目A');
  });

  it('does NOT apply the Inbox/Quick Start routing rule (that is the pull layer)', () => {
    // The raw split is shape-only. Sync pulls must go through
    // routePulledListToProject; this documents that they are NOT the same fn.
    expect(parseProjectFromListName('Passion / Quick Start')).toBe('Quick Start');
    expect(parseProjectFromListName('Inbox')).toBe('Inbox');
  });
});

// ── The pull-side routing rule (must mirror the v5 migration) ───────────────

describe('routePulledListToProject', () => {
  it('routes a trailing "Quick Start" segment to Inbox under ANY category', () => {
    // The exact remote list names that resurrected 'Quick Start' as a project.
    expect(routePulledListToProject('Passion / Quick Start')).toBe('');
    expect(routePulledListToProject('Inbox / Quick Start')).toBe('');
    expect(routePulledListToProject('Work / quick start')).toBe('');
    expect(routePulledListToProject('Quick Start')).toBe('');
  });

  it('routes a whole-name "Inbox" list to Inbox, case-insensitively', () => {
    expect(routePulledListToProject('Inbox')).toBe('');
    expect(routePulledListToProject('inbox')).toBe('');
    expect(routePulledListToProject('  INBOX  ')).toBe('');
  });

  it('keeps a real project name, including a legacy two-level list', () => {
    expect(routePulledListToProject('Work / VPA')).toBe('VPA');
    expect(routePulledListToProject('personal')).toBe('Personal');
    expect(routePulledListToProject('工作 / 项目A')).toBe('项目A');
  });

  it('does NOT route a project whose name merely CONTAINS the retired words', () => {
    expect(routePulledListToProject('Quick Start Guide')).toBe('Quick Start Guide');
    expect(routePulledListToProject('Work / Inbox Zero')).toBe('Inbox Zero');
  });

  it('keeps an "Inbox" LEADING segment — only the trailing segment names a project', () => {
    // "Inbox / Marina" is category Inbox + project Marina → the project survives
    // (promoteLegacyGroup only sends the degenerate Inbox group to Inbox).
    expect(routePulledListToProject('Inbox / Marina')).toBe('Marina');
  });

  it('handles empty / whitespace list names', () => {
    expect(routePulledListToProject('')).toBe('');
    expect(routePulledListToProject('   ')).toBe('');
  });
});

describe('retired-group predicates', () => {
  it('isRetiredQuickStartGroup matches only the exact retired name', () => {
    expect(isRetiredQuickStartGroup('Quick Start')).toBe(true);
    expect(isRetiredQuickStartGroup('quick start')).toBe(true);
    expect(isRetiredQuickStartGroup(' Quick Start ')).toBe(true);
    expect(isRetiredQuickStartGroup('Quick Start Guide')).toBe(false);
    expect(isRetiredQuickStartGroup('')).toBe(false);
  });

  it('isLegacyInboxGroup matches only the exact retired name', () => {
    expect(isLegacyInboxGroup('Inbox')).toBe(true);
    expect(isLegacyInboxGroup('INBOX')).toBe(true);
    expect(isLegacyInboxGroup('Inbox Zero')).toBe(false);
    expect(isLegacyInboxGroup('')).toBe(false);
  });
});
