/**
 * The browser half of the draft mirror (web/src/utils/draft-merge.ts): how this
 * browser's drafts and the server's are merged at boot and on focus.
 */
import { describe, it, expect } from 'vitest';
import { foldPending, hasCredential, isDraftKey, planDraftMerge, type DraftEntry } from '../../web/src/utils/draft-merge';

function local(values: Record<string, string>, ts: Record<string, number>) {
  return { get: (k: string) => values[k] ?? null, ts: (k: string) => ts[k], keys: () => Object.keys(values) };
}

describe('planDraftMerge', () => {
  const NOW = 1_000;

  it('takes a server draft this browser does not have (typed in another browser)', () => {
    const plan = planDraftMerge({ 'draft:a': { v: 'from chrome', ts: 5 } }, local({}, {}), NOW);
    expect(plan.adopt).toEqual({ 'draft:a': { v: 'from chrome', ts: 5 } });
    expect(plan.push).toEqual({});
  });

  it('a newer local write wins and is pushed; a newer server write wins and is taken', () => {
    const plan = planDraftMerge(
      { 'draft:a': { v: 'server', ts: 5 }, 'draft:b': { v: 'server', ts: 9 } },
      local({ 'draft:a': 'mine', 'draft:b': 'mine' }, { 'draft:a': 7, 'draft:b': 8 }), NOW);
    expect(plan.push).toEqual({ 'draft:a': { v: 'mine', ts: 7 } });
    expect(plan.adopt).toEqual({ 'draft:b': { v: 'server', ts: 9 } });
  });

  it('a draft sent elsewhere (newer tombstone) is removed here', () => {
    const plan = planDraftMerge({ 'draft:a': { v: null, ts: 9 } }, local({ 'draft:a': 'old' }, { 'draft:a': 3 }), NOW);
    expect(plan.adopt).toEqual({ 'draft:a': { v: null, ts: 9 } });
  });

  it('a draft sent here (newer local tombstone) is pushed as one, never brought back', () => {
    const plan = planDraftMerge({ 'draft:a': { v: 'old', ts: 3 } }, local({}, { 'draft:a': 9 }), NOW);
    expect(plan.adopt).toEqual({});
    expect(plan.push).toEqual({ 'draft:a': { v: null, ts: 9 } });
  });

  it('a local draft the mirror never stamped (written before it existed) is kept and pushed', () => {
    const plan = planDraftMerge({ 'draft:a': { v: 'server', ts: 999 } }, local({ 'draft:a': 'legacy', 'draft:b': 'legacy b' }, {}), NOW);
    expect(plan.adopt).toEqual({});
    expect(plan.push).toEqual({ 'draft:a': { v: 'legacy', ts: NOW }, 'draft:b': { v: 'legacy b', ts: NOW } });
  });

  it('ignores keys that are not drafts', () => {
    const plan = planDraftMerge({ 'open-walnut-theme': { v: 'dark', ts: 5 } }, local({ 'walnut.deviceToken': 't' }, {}), NOW);
    expect(plan).toEqual({ adopt: {}, push: {} });
  });
});

describe('isDraftKey / foldPending', () => {
  it('names the draft families', () => {
    expect(isDraftKey('draft:session:s1')).toBe(true);
    expect(isDraftKey('side-thread-draft:s1')).toBe(true);
    expect(isDraftKey('open-walnut-x')).toBe(false);
  });
  it('keeps the newer write of a key in a batch', () => {
    const m = new Map<string, DraftEntry>();
    foldPending(m, 'draft:a', { v: 'b', ts: 2 });
    foldPending(m, 'draft:a', { v: 'a', ts: 1 });
    expect(m.get('draft:a')).toEqual({ v: 'b', ts: 2 });
  });
});

describe('hasCredential', () => {
  it('keeps credential-bearing words off the server copy', () => {
    expect(hasCredential('https://bob:hunter2@example.com/repo.git')).toBe(true);
    expect(hasCredential('use sk-abcdefghijklmnopqrstuvwx please')).toBe(true);
    expect(hasCredential('ghp_' + 'a'.repeat(36))).toBe(true);
    expect(hasCredential('https://example.com/repo.git')).toBe(false);
    expect(hasCredential('https://hook.example.com/in?token=abcdef123456')).toBe(true);
    expect(hasCredential('https://example.com/search?q=token&page=2')).toBe(false);
    expect(hasCredential('mail bob@example.com about the skeleton')).toBe(false);
    const plan = planDraftMerge({}, local({ 'draft:a': 'https://u:p@h.example/x' }, {}), 1);
    expect(plan.push).toEqual({});
  });
});
