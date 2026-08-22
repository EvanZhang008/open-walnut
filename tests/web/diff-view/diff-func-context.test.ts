/**
 * Unit tests for diffFuncContext.ts — the "which function is this?" scan behind
 * the Changed view's collapsed-context bars (client-side equivalent of git's
 * hunk-header funcname), and the hidden-only display rule.
 *
 * Runs under vitest.diff-view.config.ts (web-rooted, for the `@/` alias).
 */
import { describe, it, expect } from 'vitest';
import { functionContext, hiddenFunctionContext, splitSourceLines } from '@/components/sessions/diffFuncContext';

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
  it('finds the enclosing Java method (and its line) for an indented body line', () => {
    expect(functionContext(java, 10)).toEqual({ text: 'private void deliverEventsToConsumers(JsonNode event,', line: 7 });
  });

  it('names the definition itself when the line IS the definition', () => {
    expect(functionContext(java, 7)?.line).toBe(7);
  });

  it('falls back to the class above the methods', () => {
    expect(functionContext(java, 4)).toEqual({ text: 'public class EventDelivery', line: 3 });
  });

  it('skips annotations and comments while scanning up', () => {
    const src = splitSourceLines(['def handler():', '    # a comment', '    // nope', '    x = 1'].join('\n'));
    expect(functionContext(src, 4)?.text).toBe('def handler()');
  });

  it('handles go func receivers and ts arrow consts', () => {
    const go = splitSourceLines(['func (f *Factory) HasSynced(gate []string) bool {', '\treturn true'].join('\n'));
    expect(functionContext(go, 2)?.text).toBe('func (f *Factory) HasSynced(gate []string) bool');
    const ts = splitSourceLines(['export const load = async (id: string) => {', '  fetch(id);'].join('\n'));
    expect(functionContext(ts, 2)?.text).toBe('export const load = async (id: string) =>');
  });

  it('returns null when nothing definition-like exists above', () => {
    const src = splitSourceLines(['  // just', '  # noise', '  }'].join('\n'));
    expect(functionContext(src, 3)).toBeNull();
  });

  it('clamps out-of-range lines instead of throwing', () => {
    expect(functionContext(java, 9999)?.line).toBe(7);
    expect(functionContext([], 5)).toBeNull();
  });

  it('truncates very long definition lines for display', () => {
    const long = `function ${'x'.repeat(200)}() {`;
    const got = functionContext(splitSourceLines(`${long}\n  body();`), 2);
    expect(got!.text.length).toBeLessThanOrEqual(90);
    expect(got!.text.endsWith('…')).toBe(true);
  });
});

describe('hiddenFunctionContext', () => {
  it('pins the RAW definition line (indentation intact) when hidden in the gap', () => {
    // Gap hides lines [4, 10); def at 7 is hidden → pin.
    expect(hiddenFunctionContext(java, 10, 4, 10)).toEqual({
      raw: '    private void deliverEventsToConsumers(JsonNode event,',
      line: 7,
    });
  });

  it('no pin when the definition is visible below the bar (hunk starts at it)', () => {
    // Hunk starts AT the def (line 7); gap hides [4, 7) → def visible → no pin.
    expect(hiddenFunctionContext(java, 7, 4, 7)).toBeNull();
  });

  it('no pin when the definition is visible ABOVE the gap (in the previous hunk)', () => {
    // Gap hides only [9, 11); def at 7 sits in the visible hunk above → no pin.
    expect(hiddenFunctionContext(java, 11, 9, 11)).toBeNull();
  });

  it('no pin when the definition sits in an EARLIER gap — no repeats down a long function', () => {
    // Def at 7 was hidden by a previous bar's gap; this gap hides [9, 11) only.
    // Same predicate as the visible-above case, asserted for the repeat story.
    expect(hiddenFunctionContext(java, 10, 9, 11)).toBeNull();
  });

  it('leading gap: everything above the first hunk is hidden → pin', () => {
    expect(hiddenFunctionContext(java, 10, 1, 10)?.line).toBe(7);
  });
});
