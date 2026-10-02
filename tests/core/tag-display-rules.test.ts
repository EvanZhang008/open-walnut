/**
 * The tag display rule set shared by the server and the web (src/core/tag-display-rules.ts):
 * who decides how a tag shows (whole, value only, hidden), in what order, and what counts as a
 * rule pattern. Every stored tag is key:value (tag-model.ts), so a plain word is a label.
 */
import { describe, expect, it } from 'vitest';
import {
  BUILTIN_TAG_DISPLAY_RULES,
  DEFAULT_TAG_DISPLAY_RULES,
  compileTagDisplay,
  isMachineTagPattern,
  normalizeTagPattern,
  patternForTag,
  patternNamespace,
  shownTags,
  tagNamespace,
  tagValue,
  type TagDisplay,
  type TagDisplayRule,
} from '../../src/core/tag-display-rules.js';

const rule = (pattern: string, display: TagDisplay, source: TagDisplayRule['source'], pluginId?: string): TagDisplayRule =>
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

  it('turns a tag into the pattern its switch sets: the key, except for a label, which is its own', () => {
    expect(patternForTag('severity:2')).toBe('severity:*');
    expect(patternForTag('label:urgent')).toBe('label:urgent');
    expect(patternForTag('urgent')).toBe('urgent');
    expect(tagValue('ticket:V1234567890')).toBe('V1234567890');
    expect(tagValue('a:b:c')).toBe('b:c');
    expect(tagValue('urgent')).toBe('urgent');
    expect(patternNamespace('severity:*')).toBe('severity');
    expect(patternNamespace('severity:2')).toBeUndefined();
    expect(patternNamespace('a:b:*')).toBeUndefined();
    expect(patternNamespace(':*')).toBeUndefined();
  });

  it('normalizes a stored pattern and rejects what is not one', () => {
    expect(normalizeTagPattern('  severity:* ')).toBe('severity:*');
    expect(normalizeTagPattern('Severity:*')).toBe('severity:*');
    // A plain word is the label it is stored as; a derived date stays a date.
    expect(normalizeTagPattern('urgent')).toBe('label:urgent');
    expect(normalizeTagPattern('Team:Marina')).toBe('team:Marina');
    expect(normalizeTagPattern('created:*')).toBe('created:*');
    expect(normalizeTagPattern('my key:*')).toBeNull();
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
  it('shows every tag whole by default and never shows a machine tag', () => {
    const compiled = compileTagDisplay([...BUILTIN_TAG_DISPLAY_RULES]);
    expect(compiled.display('severity:2')).toBe('shown');
    expect(compiled.valueOnly('severity:2')).toBe(false);
    expect(compiled.shown('walnut:external-sessions')).toBe(false);
    expect(compiled.ruleFor('walnut:external-sessions')).toEqual(BUILTIN_TAG_DISPLAY_RULES[0]);
    expect(compiled.ruleFor('severity:2')).toBeUndefined();
  });

  it('applies Walnut\'s defaults even when the list does not carry them: labels read as their value, dates hidden', () => {
    for (const compiled of [compileTagDisplay([]), compileTagDisplay([...BUILTIN_TAG_DISPLAY_RULES, ...DEFAULT_TAG_DISPLAY_RULES])]) {
      expect(compiled.display('label:urgent')).toBe('value');
      expect(compiled.shown('label:urgent')).toBe(true);
      expect(compiled.valueOnly('label:urgent')).toBe(true);
      expect(compiled.shown('created:2026-10-01')).toBe(false);
      expect(compiled.shown('updated:2026-10-01')).toBe(false);
      expect(compiled.ruleFor('created:2026-10-01')?.source).toBe('default');
    }
  });

  it('lets a plugin or the user override Walnut\'s default', () => {
    const compiled = compileTagDisplay([
      rule('label:*', 'shown', 'plugin', 'p'),
      rule('created:*', 'shown', 'user'),
    ]);
    expect(compiled.display('label:urgent')).toBe('shown');
    expect(compiled.display('created:2026-10-01')).toBe('shown');
    expect(compiled.display('updated:2026-10-01')).toBe('hidden');
  });

  it('shows a ticket as its value when a plugin says so, the same for every id', () => {
    const compiled = compileTagDisplay([rule('ticket:*', 'value', 'plugin', 'ticket-runs'), rule('ticket-id:*', 'hidden', 'plugin', 'ticket-runs')]);
    for (const tag of ['ticket:V2391099522', 'ticket:P123456789', 'ticket:D12345678']) {
      expect(compiled.display(tag)).toBe('value');
    }
    expect(compiled.display('sev:2')).toBe('shown');
    expect(shownTags(['ticket:V1', 'ticket-id:uuid', 'sev:2'], compiled)).toEqual(['ticket:V1', 'sev:2']);
  });

  it('between plugins the quieter wins (hidden, then value), whatever the order', () => {
    const orders = [
      [rule('ticket:*', 'shown', 'plugin', 'a'), rule('ticket:*', 'value', 'plugin', 'b')],
      [rule('ticket:*', 'value', 'plugin', 'b'), rule('ticket:*', 'shown', 'plugin', 'a')],
    ];
    for (const rules of orders) expect(compileTagDisplay(rules).display('ticket:V1')).toBe('value');
    expect(compileTagDisplay([rule('ticket:*', 'value', 'plugin', 'b'), rule('ticket:*', 'hidden', 'plugin', 'c')]).display('ticket:V1')).toBe('hidden');
  });

  it('lets a user rule beat a plugin default, an exact tag beat its namespace, and hidden beat shown between plugins', () => {
    const compiled = compileTagDisplay([
      rule('ticket-id:*', 'hidden', 'plugin', 'ticket-runs'),
      rule('ticket-id:*', 'shown', 'plugin', 'other'),
      rule('ticket-id:special', 'shown', 'plugin', 'ticket-runs'),
      rule('severity:*', 'hidden', 'plugin', 'ticket-runs'),
      rule('severity:*', 'shown', 'user'),
      rule('severity:5', 'hidden', 'user'),
      // A plain word in a rule names the label it is stored as.
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
    expect(compiled.shown('label:urgent')).toBe(false);
    // A user rule can never reach a machine tag.
    expect(compileTagDisplay([rule('walnut:*', 'shown', 'user')]).shown('walnut:x')).toBe(false);
  });

  it('ignores malformed rules and keeps the last user rule for one pattern', () => {
    const compiled = compileTagDisplay([
      rule('', 'hidden', 'user'),
      rule('a:b:*', 'hidden', 'user'),
      { pattern: 'label:urgent', display: 'maybe' as 'shown', source: 'user' },
      rule('label:later', 'hidden', 'user'),
      rule('label:later', 'value', 'user'),
    ]);
    expect(compiled.display('label:urgent')).toBe('value');
    expect(compiled.display('label:later')).toBe('value');
  });

  it('filters a task\'s tags in their order', () => {
    const compiled = compileTagDisplay([rule('ticket-id:*', 'hidden', 'plugin', 'ticket-runs')]);
    expect(shownTags(['ticket:P1', 'ticket-id:uuid', 'severity:2', 'walnut:external-sessions'], compiled)).toEqual(['ticket:P1', 'severity:2']);
    expect(shownTags(undefined, compiled)).toEqual([]);
  });
});
