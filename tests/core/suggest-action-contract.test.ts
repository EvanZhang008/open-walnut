/**
 * The `<suggest>` prompt section rides the STABLE, prompt-cached prefix, so it
 * pays its cost on every conversation: keep it capped, and keep it teaching the
 * exact syntax the parser accepts (web/src/utils/suggest-parse.ts).
 */
import { describe, expect, it } from 'vitest';
import {
  SUGGEST_ACTION_PROMPT_MAX_CHARS,
  renderSuggestActionContract,
} from '../../src/core/suggest-action-contract.js';
import { buildWorkModesSection } from '../../src/agent/context.js';

describe('suggested-action contract', () => {
  it('stays inside its prompt budget and stays short enough to read', () => {
    const prompt = renderSuggestActionContract();
    expect(prompt.length).toBeLessThanOrEqual(SUGGEST_ACTION_PROMPT_MAX_CHARS);
    expect(prompt.split('\n').length).toBeLessThanOrEqual(15);
  });

  it('teaches the tags and attributes the parser actually accepts', () => {
    const prompt = renderSuggestActionContract();
    expect(prompt).toContain('<suggest');
    expect(prompt).toContain('</suggest>');
    expect(prompt).toContain('<action');
    expect(prompt).toContain('dismiss');
    expect(prompt).toContain('args=');
    expect(prompt).toContain('confirm=');
    expect(prompt).toContain('multi');
    expect(prompt).toContain('sticky');
  });

  it('keeps cards optional, because only the console renders them', () => {
    const prompt = renderSuggestActionContract();
    expect(prompt).toContain('MAY');
    expect(prompt).toMatch(/other surfaces show the raw text/i);
  });

  it('reaches the shared work-modes section every Main Agent lane builds', () => {
    expect(buildWorkModesSection()).toContain(renderSuggestActionContract());
  });
});
