/**
 * The tag display rule set shared by the server and the web (src/core/tag-display-rules.ts):
 * who decides whether a tag shows, in what order, and what counts as a rule pattern.
 */
import { describe, expect, it } from 'vitest';
import {
  BUILTIN_TAG_DISPLAY_RULES,
  compileTagDisplay,
  isMachineTagPattern,
  normalizeTagPattern,
  patternForTag,
  patternNamespace,
  shownTags,
  tagNamespace,
  type TagDisplayRule,
} from '../../src/core/tag-display-rules.js';

const rule = (pattern: string, display: 'shown' | 'hidden', source: TagDisplayRule['source'], pluginId?: string): TagDisplayRule =>
  ({ pattern, display, source, ...(pluginId ? { pluginId } : {}) });

describe('tag namespaces and patterns', () => {
  it('splits a tag at its first colon only when both sides have text', () => {
    expect(tagNamespace('severity:2')).toBe('severity');
    expect(tagNamespace('ticket-id:c186a5a9-03f2')).toBe('ticket-id');
    expect(tagNamespace('a:b:c')).toBe('a');
    expect(tagNamespace('urgent')).toBeUndefined();
    expect(tagNamespace(':leading')).toBeUndefined();
    expect(tagNamespace('trailing:')).toBeUndefined();
  });

  it('turns a tag into the pattern its switch sets: the namespace when it has one, else itself', () => {
    expect(patternForTag('severity:2')).toBe('severity:*');
    expect(patternForTag('urgent')).toBe('urgent');
    expect(patternNamespace('severity:*')).toBe('severity');
    expect(patternNamespace('severity:2')).toBeUndefined();
    expect(patternNamespace('a:b:*')).toBeUndefined();
    expect(patternNamespace(':*')).toBeUndefined();
  });

  it('normalizes a stored pattern and rejects what is not one', () => {
    expect(normalizeTagPattern('  severity:* ')).toBe('severity:*');
    expect(normalizeTagPattern('urgent')).toBe('urgent');
    expect(normalizeTagPattern('')).toBeNull();
    expect(normalizeTagPattern('   ')).toBeNull();
    expect(normalizeTagPattern('a:b:*')).toBeNull();
    expect(normalizeTagPattern('with\nnewline')).toBeNull();
    expect(normalizeTagPattern('x'.repeat(201))).toBeNull();
    expect(normalizeTagPattern(42)).toBeNull();
  });

  it('knows Walnut\'s machine tags by their namespace, as a tag or a pattern', () => {
    expect(isMachineTagPattern('walnut:*')).toBe(true);
    expect(isMachineTagPattern('walnut:external-sessions')).toBe(true);
    expect(isMachineTagPattern('walnuts:*')).toBe(false);
    expect(isMachineTagPattern('walnut')).toBe(false);
  });
});

describe('compileTagDisplay', () => {
  it('shows every tag by default and never shows a machine tag', () => {
    const compiled = compileTagDisplay([...BUILTIN_TAG_DISPLAY_RULES]);
    expect(compiled.shown('urgent')).toBe(true);
    expect(compiled.shown('severity:2')).toBe(true);
    expect(compiled.shown('walnut:external-sessions')).toBe(false);
    expect(compiled.ruleFor('walnut:external-sessions')).toEqual(BUILTIN_TAG_DISPLAY_RULES[0]);
    expect(compiled.ruleFor('urgent')).toBeUndefined();
  });

  it('lets a user rule beat a plugin default, an exact tag beat its namespace, and hidden beat shown between plugins', () => {
    const compiled = compileTagDisplay([
      rule('ticket-id:*', 'hidden', 'plugin', 'ticket-runs'),
      rule('ticket-id:*', 'shown', 'plugin', 'other'),
      rule('ticket-id:special', 'shown', 'plugin', 'ticket-runs'),
      rule('severity:*', 'hidden', 'plugin', 'ticket-runs'),
      rule('severity:*', 'shown', 'user'),
      rule('severity:5', 'hidden', 'user'),
      rule('urgent', 'hidden', 'user'),
    ]);
    // Plugins disagree on a namespace: hidden wins, whatever the order.
    expect(compiled.shown('ticket-id:abc')).toBe(false);
    // A plugin's exact tag beats its own namespace.
    expect(compiled.shown('ticket-id:special')).toBe(true);
    // The user shows a namespace a plugin hides, and hides one tag inside it.
    expect(compiled.display('severity:2')).toBe('shown');
    expect(compiled.ruleFor('severity:2')).toEqual(rule('severity:*', 'shown', 'user'));
    expect(compiled.display('severity:5')).toBe('hidden');
    expect(compiled.shown('urgent')).toBe(false);
    // A user rule can never reach a machine tag.
    expect(compileTagDisplay([rule('walnut:*', 'shown', 'user')]).shown('walnut:x')).toBe(false);
  });

  it('ignores malformed rules and keeps the last user rule for one pattern', () => {
    const compiled = compileTagDisplay([
      rule('', 'hidden', 'user'),
      rule('a:b:*', 'hidden', 'user'),
      { pattern: 'urgent', display: 'maybe' as 'shown', source: 'user' },
      rule('later', 'hidden', 'user'),
      rule('later', 'shown', 'user'),
    ]);
    expect(compiled.shown('urgent')).toBe(true);
    expect(compiled.shown('later')).toBe(true);
  });

  it('filters a task\'s tags in their order', () => {
    const compiled = compileTagDisplay([rule('ticket-id:*', 'hidden', 'plugin', 'ticket-runs')]);
    expect(shownTags(['ticket:P1', 'ticket-id:uuid', 'severity:2', 'walnut:external-sessions'], compiled)).toEqual(['ticket:P1', 'severity:2']);
    expect(shownTags(undefined, compiled)).toEqual([]);
  });
});
