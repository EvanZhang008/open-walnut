import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';

let tmpDir: string;

// Mock constants
vi.mock('../../src/constants.js', () => createMockConstants());

// Mock the model to avoid real API calls
vi.mock('../../src/agent/model.js', () => ({
  sendMessage: vi.fn(),
  sendMessageStream: vi.fn(),
  resetClient: vi.fn(),
  DEFAULT_MODEL: 'global.anthropic.claude-opus-4-6-v1',
  getContextWindowSize: (model?: string) => model?.includes('[1m]') ? 1_000_000 : 200_000,
  getContextThreshold: (model: string | undefined, percent: number) =>
    Math.round((model?.includes('[1m]') ? 1_000_000 : 200_000) * percent),
}));

import { WALNUT_HOME } from '../../src/constants.js';
import { isToolResultError } from '../../src/agent/loop.js';

beforeEach(async () => {
  tmpDir = WALNUT_HOME;
  await fs.rm(tmpDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

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
