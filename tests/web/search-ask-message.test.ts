/**
 * The transcript side of the ✦ search: the prompt Walnut sent folds into ONE
 * disclosure row and the bubble keeps only the human's query.
 *
 * Built with the server's real prompt builders, so a reworded prompt fails here
 * rather than quietly leaving a 2.5KB JSON dump in a chat bubble.
 */

import { describe, expect, it } from 'vitest';
import { buildSeedResultsBlock, buildUserPrompt } from '../../src/core/task-search-agent-contract.js';
import { SEARCH_PROMPT_BANNER, searchPromptBannerSplit } from '@/components/sessions/search-ask';
import { splitLeadingBanners } from '@/components/sessions/injected-banner';

const ROWS = JSON.stringify([
  { type: 'task', title: 'Unit test board search', taskId: 'mu4qx48p-4828', phase: 'COMPLETE', updated: '2026-09-16' },
  { type: 'session', title: 'Assess disk-read follow-up', taskId: 'mm7a4bc7-9680', phase: 'COMPLETE', updated: '2026-08-08' },
]);

describe('searchPromptBannerSplit', () => {
  it('leaves the query as the bubble and folds the whole prompt into one row', () => {
    const text = buildUserPrompt('unit test') + buildSeedResultsBlock(ROWS);
    const split = searchPromptBannerSplit(text);
    expect(split).not.toBeNull();
    expect(split!.body).toBe('unit test');
    expect(split!.banners).toHaveLength(1);
    const [banner] = split!.banners;
    expect(banner.name).toBe(SEARCH_PROMPT_BANNER);
    expect(banner.label).toBe('✦ Search prompt Walnut sent · 2 seed rows');
    // Collapse, not strip: the disclosure holds the prompt verbatim, and the row
    // dump is inside a code block so it reads as data instead of as a paragraph.
    expect(banner.raw).toBe(text);
    expect(banner.body).toContain(ROWS);
    expect(banner.body.startsWith('```text\n')).toBe(true);
    expect(banner.body.endsWith('\n```')).toBe(true);
  });

  it('says "1 seed row" for a single row and drops the count with no seed block', () => {
    const one = buildUserPrompt('unit test') + buildSeedResultsBlock(JSON.stringify([{ type: 'task', taskId: 'a' }]));
    expect(searchPromptBannerSplit(one)!.banners[0].label).toBe('✦ Search prompt Walnut sent · 1 seed row');
    expect(searchPromptBannerSplit(buildUserPrompt('unit test'))!.banners[0].label).toBe('✦ Search prompt Walnut sent');
  });

  it('cannot be broken out of by a query containing a code fence', () => {
    const text = buildUserPrompt('why does ```json break') + buildSeedResultsBlock(ROWS);
    const banner = searchPromptBannerSplit(text)!.banners[0];
    // A longer fence than anything inside, so the prompt stays one code block.
    expect(banner.body.startsWith('````text\n')).toBe(true);
    expect(banner.body.endsWith('\n````')).toBe(true);
    expect(banner.body).toContain('```json break');
    expect(searchPromptBannerSplit(text)!.body).toBe('why does ```json break');
  });

  it('returns null for anything that is not that prompt', () => {
    expect(searchPromptBannerSplit('fix the build please')).toBeNull();
    expect(searchPromptBannerSplit('')).toBeNull();
    // The bracket-banner splitter keeps owning its own shape — the two readers
    // must not compete for the same message.
    const banner = '[Conversation context]\nturns you have not seen\n[/Conversation context]\n\nwhat I typed';
    expect(searchPromptBannerSplit(banner)).toBeNull();
    expect(splitLeadingBanners(banner)?.body).toBe('what I typed');
  });
});
