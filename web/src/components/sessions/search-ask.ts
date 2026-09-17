/**
 * The ✦ AI search's two messages, as a session transcript shows them — pure,
 * dependency-free, render-agnostic.
 *
 * "Open as session" hands the user the very session the search ran in, so its
 * first user turn is the prompt WALNUT wrote (question + a ~2.5KB seed-row dump)
 * and its answer is a bare JSON object. Both are machine text in a chat panel.
 *
 * The prompt reuses the panel's existing answer for exactly this problem: the
 * `[Banner]…[/Banner]` splitter folds machine text Walnut added into a disclosure
 * row and leaves the human's words as the bubble (injected-banner.ts). A search
 * prompt is not bracket-fenced, so it cannot be found by that scan — but once
 * recognized it produces the SAME BannerSplit, which means one visual language,
 * one tested disclosure row, and `Copy message` / pins / the outline all see the
 * QUERY instead of a wall of JSON.
 *
 * The shapes themselves live in the module the server builds them with
 * (`@open-walnut/search-transcript`), so the sentinels and their reader cannot
 * drift apart.
 */

import { parseSearchPromptMessage } from '@open-walnut/search-transcript';
import type { BannerSplit } from './injected-banner';

/** `data-banner-name` for the folded prompt, and the tests' locator. */
export const SEARCH_PROMPT_BANNER = 'AI search prompt';

/**
 * A fence longer than any backtick run inside `text`, so a query containing a
 * code fence cannot break out of the disclosure's code block.
 */
function safeFence(text: string): string {
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return '`'.repeat(Math.max(3, longest + 1));
}

/**
 * Recognize Walnut's own search prompt in a user turn and split it the way a
 * banner splits: the query becomes the bubble, the whole prompt (verbatim, in a
 * code block so a JSON row dump stays readable) becomes one folded row.
 *
 * Returns null for anything that is not that prompt, which means "render exactly
 * what you render today".
 */
export function searchPromptBannerSplit(text: string): BannerSplit | null {
  const prompt = parseSearchPromptMessage(text);
  if (!prompt) return null;
  const fence = safeFence(prompt.raw);
  const rows = prompt.seedRows;
  return {
    banners: [{
      name: SEARCH_PROMPT_BANNER,
      // Names the author, like every other banner label: the whole defect is
      // machine text reading as the user's own.
      label: rows !== undefined
        ? `✦ Search prompt Walnut sent · ${rows} seed ${rows === 1 ? 'row' : 'rows'}`
        : '✦ Search prompt Walnut sent',
      body: `${fence}text\n${prompt.raw}\n${fence}`,
      raw: prompt.raw,
    }],
    body: prompt.query.trim(),
  };
}
