import { describe, it, expect, vi } from 'vitest';
import { createMockConstants } from '../helpers/mock-constants.js';

// The module graph reaches config-manager through model.js; keep its paths in a temp dir.
vi.mock('../../src/constants.js', () => createMockConstants('walnut-tool-error-detection'));

import { isToolResultError } from '../../src/model/micro-agent.js';

describe('isToolResultError', () => {
  describe('string inputs', () => {
    it('returns true for "Error: some message"', () => {
      expect(isToolResultError('Error: file not found')).toBe(true);
    });

    it('returns true for "Error executing tool_name: ..."', () => {
      expect(isToolResultError('Error executing write_file: permission denied')).toBe(true);
    });

    it('returns true for "error: ..." (case-insensitive)', () => {
      expect(isToolResultError('error: something went wrong')).toBe(true);
    });

    it('returns true for "Error " with space (no colon)', () => {
      expect(isToolResultError('Error happened during execution')).toBe(true);
    });

    it('returns false for normal success output like JSON', () => {
      expect(isToolResultError('{"status":"ok"}')).toBe(false);
    });

    it('returns false for normal text output', () => {
      expect(isToolResultError('Task created successfully.')).toBe(false);
    });

    it('returns false for strings mentioning "error" but not starting with it', () => {
      expect(isToolResultError('No error occurred during this operation.')).toBe(false);
    });

    it('returns false for "error" appearing mid-sentence', () => {
      expect(isToolResultError('The previous error has been resolved.')).toBe(false);
    });

    it('returns false for empty string', () => {
      expect(isToolResultError('')).toBe(false);
    });

    it('returns false for strings starting with "Errors" (plural, no colon/space follows E-r-r-o-r)', () => {
      // "Errors" has an 's' right after "Error", but the regex checks for : or \s after "Error"
      // Actually "Errors" = "Error" + "s" — the regex is /^Error[:\s]/i
      // "s" is neither : nor \s, so this should be false
      expect(isToolResultError('Errors were found in the log')).toBe(false);
    });
  });

  describe('structured content blocks (arrays)', () => {
    it('returns true when first text block starts with "Error:"', () => {
      const result = [
        { type: 'text' as const, text: 'Error: task not found' },
      ];
      expect(isToolResultError(result)).toBe(true);
    });

    it('returns true when text block starts with "Error executing"', () => {
      const result = [
        { type: 'text' as const, text: 'Error executing query_tasks: database unavailable' },
      ];
      expect(isToolResultError(result)).toBe(true);
    });

    it('returns false when text block has normal content', () => {
      const result = [
        { type: 'text' as const, text: '{"tasks": []}' },
      ];
      expect(isToolResultError(result)).toBe(false);
    });

    it('returns false for array with only image blocks (no text)', () => {
      const result = [
        { type: 'image' as const, source: { type: 'base64', media_type: 'image/png', data: 'abc' } },
      ];
      expect(isToolResultError(result)).toBe(false);
    });

    it('checks the first text block even when preceded by image blocks', () => {
      const result = [
        { type: 'image' as const, source: { type: 'base64', media_type: 'image/png', data: 'abc' } },
        { type: 'text' as const, text: 'Error: screenshot capture failed' },
      ];
      expect(isToolResultError(result)).toBe(true);
    });

    it('returns false for empty array', () => {
      expect(isToolResultError([])).toBe(false);
    });
  });
});
