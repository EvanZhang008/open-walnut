/** Eligibility policy for the AI search lane. */
import { describe, expect, it } from 'vitest';
import {
  AGENT_SEARCH_DEBOUNCE_MS,
  isAgentSearchEligible,
} from '@/hooks/agentSearchTrigger';

describe('isAgentSearchEligible', () => {
  it('rejects short fragments the instant lane already covers', () => {
    expect(isAgentSearchEligible('abc')).toBe(false);
    expect(isAgentSearchEligible('docx')).toBe(false);
    expect(isAgentSearchEligible('  a  ')).toBe(false);
  });

  it('accepts multi-word questions', () => {
    expect(isAgentSearchEligible('which task adds docx support')).toBe(true);
    expect(isAgentSearchEligible('docx preview')).toBe(true);
  });

  it('rejects pasted ids and urls — those are navigation commands', () => {
    expect(isAgentSearchEligible('12345678-1234-4abc-8def-1234567890ab')).toBe(false);
    expect(isAgentSearchEligible('mt65k8x5-8c2d')).toBe(false);
    expect(isAgentSearchEligible('https://github.com/some/repo/pull/42')).toBe(false);
  });

  it('accepts CJK queries at natural (short) lengths', () => {
    expect(isAgentSearchEligible('文件预览扩展格式')).toBe(true);
  });

  it('accepts one long descriptive token', () => {
    expect(isAgentSearchEligible('notification-redesign')).toBe(true);
  });

  it('debounces LONGER than the instant lane (500ms) so the AI fires after settle', () => {
    expect(AGENT_SEARCH_DEBOUNCE_MS).toBeGreaterThan(500);
  });
});
