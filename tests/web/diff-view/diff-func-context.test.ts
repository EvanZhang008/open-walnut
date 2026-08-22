/**
 * Unit tests for diffFuncContext.ts — the "which function is this?" scan behind
 * the Changed view's collapsed-context bars (client-side equivalent of git's
 * hunk-header funcname).
 *
 * Runs under vitest.diff-view.config.ts (web-rooted, for the `@/` alias).
 */
import { describe, it, expect } from 'vitest';
import { functionContext, splitSourceLines } from '@/components/sessions/diffFuncContext';

const java = splitSourceLines([
  'package acme;',                                        // 1
  '',                                                     // 2
  'public class EventDelivery {',                         // 3
  '    private static final int MAX = 3;',                // 4
  '',                                                     // 5
  '    @SuppressWarnings("checkstyle")',                  // 6
  '    private void deliverEventsToConsumers(JsonNode event,', // 7
  '            Record record) throws ConfigException {',  // 8
  '        log.debug("deliver");',                        // 9
  '        boolean isAccount = accounts.contains(id);',   // 10
  '        int x = 1;',                                   // 11
  '    }',                                                // 12
  '}',                                                    // 13
].join('\n'));

describe('functionContext', () => {
  it('finds the enclosing Java method for an indented body line', () => {
    expect(functionContext(java, 10)).toBe('private void deliverEventsToConsumers(JsonNode event,');
  });

  it('names the definition itself when the line IS the definition', () => {
    expect(functionContext(java, 7)).toBe('private void deliverEventsToConsumers(JsonNode event,');
  });

  it('falls back to the class above the methods', () => {
    expect(functionContext(java, 4)).toBe('public class EventDelivery');
  });

  it('skips annotations and comments while scanning up', () => {
    const src = splitSourceLines(['def handler():', '    # a comment', '    // nope', '    x = 1'].join('\n'));
    expect(functionContext(src, 4)).toBe('def handler()');
  });

  it('handles go func receivers and ts arrow consts', () => {
    const go = splitSourceLines(['func (f *Factory) HasSynced(gate []string) bool {', '\treturn true'].join('\n'));
    expect(functionContext(go, 2)).toBe('func (f *Factory) HasSynced(gate []string) bool');
    const ts = splitSourceLines(['export const load = async (id: string) => {', '  fetch(id);'].join('\n'));
    expect(functionContext(ts, 2)).toBe('export const load = async (id: string) =>');
  });

  it('returns null when nothing definition-like exists above', () => {
    const src = splitSourceLines(['  // just', '  # noise', '  }'].join('\n'));
    expect(functionContext(src, 3)).toBeNull();
  });

  it('clamps out-of-range lines instead of throwing', () => {
    expect(functionContext(java, 9999)).toBe('private void deliverEventsToConsumers(JsonNode event,');
    expect(functionContext([], 5)).toBeNull();
  });

  it('truncates very long definition lines for display', () => {
    const long = `function ${'x'.repeat(200)}() {`;
    const got = functionContext(splitSourceLines(`${long}\n  body();`), 2);
    expect(got!.length).toBeLessThanOrEqual(90);
    expect(got!.endsWith('…')).toBe(true);
  });
});
