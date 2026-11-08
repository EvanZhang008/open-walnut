/**
 * The line-comment messages the agent receives are one format on every device:
 * the web Changed tab (diffPrefill.ts) and the iOS Changed page
 * (ios-native/Walnut/Views/Sessions/Changes/DiffReview.swift) both build them, and
 * both are held to the same fixture. The iOS twin of this test is
 * ios-native/WalnutTests/DiffReviewMessageTests.swift. Change the format on one
 * side and the other side's test fails until the fixture and both builders agree.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { buildCommentMessage, buildReviewMessage } from '@/components/sessions/diffPrefill';

interface Case {
  name: string;
  comments: Array<{ loc: string; code: string; comment: string }>;
  expected: string;
  expectedEach: string[];
}

const fixture = JSON.parse(fs.readFileSync(
  path.join(__dirname, '../../../ios-native/tests/fixtures/diff-review-messages.json'), 'utf-8',
)) as { cases: Case[] };

describe('diff review messages match the shared fixture', () => {
  it('has cases', () => {
    expect(fixture.cases.length).toBeGreaterThan(2);
  });
  for (const c of fixture.cases) {
    it(c.name, () => {
      expect(buildReviewMessage(c.comments)).toBe(c.expected);
      expect(c.comments.map((x) => buildCommentMessage(x.loc, x.code, x.comment))).toEqual(c.expectedEach);
    });
  }
});
