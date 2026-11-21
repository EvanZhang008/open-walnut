/**
 * Task-tab sentinel + its `?proj=` URL encoding
 * (web/src/components/tasks/task-tabs.ts).
 *
 * Two collision classes are the whole point of this module, and both were real
 * bugs before it existed:
 *   1. INBOX_TAB used to be a TYPEABLE character (U+2205), so a project someone
 *      actually named that became indistinguishable from the Inbox chip.
 *   2. The URL used the BARE token 'inbox', so a project literally named
 *      "inbox" was unreachable via deep link. The fix reserves a '_' namespace
 *      for sentinel tokens and escapes real names that collide with it, which
 *      makes the mapping injective in BOTH directions.
 *
 * The retired ★ tab (STARRED_TAB / '_starred') was removed with the starred
 * system; its old links degrade to "a project named _starred", which TodoPanel's
 * stale-tab self-heal resolves to the All chip.
 */
import { describe, it, expect } from 'vitest';
import {
  INBOX_TAB,
  LS_TAB_KEY,
  projectToUrl,
  projectFromUrl,
} from '../../web/src/components/tasks/task-tabs';

describe('tab sentinels', () => {
  it('INBOX_TAB is a private-use codepoint (not typeable from an IME/keyboard)', () => {
    expect(INBOX_TAB).toHaveLength(1);
    const cp = INBOX_TAB.codePointAt(0)!;
    // BMP private-use area: U+E000..U+F8FF.
    expect(cp).toBeGreaterThanOrEqual(0xe000);
    expect(cp).toBeLessThanOrEqual(0xf8ff);
  });

  it('the sentinel is distinct from the All chip', () => {
    expect(new Set([INBOX_TAB, ''])).toHaveProperty('size', 2);
  });

  it('keeps the walnut-todo- prefix crash-recovery clears', () => {
    // crash-recovery.ts wipes exactly the 'open-walnut-' / 'walnut-todo-'
    // prefixes; renaming this key would drop the tab out of crash recovery.
    expect(LS_TAB_KEY.startsWith('walnut-todo-')).toBe(true);
  });
});

describe('?proj= encoding', () => {
  it('round-trips the sentinel through a readable token', () => {
    expect(projectToUrl(INBOX_TAB)).toBe('_inbox');
    expect(projectFromUrl('_inbox')).toBe(INBOX_TAB);
  });

  it('reads the bare "inbox" token (any case) as the Inbox, now that the Inbox is the project of that name', () => {
    // The Inbox is a project named "Inbox" (src/core/inbox-project.ts), so no other
    // project can hold that name and the old ambiguity is gone.
    for (const token of ['inbox', 'Inbox', 'INBOX']) expect(projectFromUrl(token)).toBe(INBOX_TAB);
  });

  it('a retired ★ deep link decodes to a plain (non-existent) project name', () => {
    // '_starred' is no longer a sentinel, so it must decode as an ordinary name
    // rather than silently mapping onto some other tab.
    expect(projectFromUrl('_starred')).toBe('_starred');
  });

  it('is injective — no two tab ids share a token', () => {
    const ids = [INBOX_TAB, '', '_inbox', '_wip', 'Marina'];
    const tokens = ids.map(projectToUrl);
    expect(new Set(tokens).size).toBe(ids.length);
    // …and every one decodes back to exactly what it encoded.
    for (const id of ids) expect(projectFromUrl(projectToUrl(id))).toBe(id);
  });

  it('leaves an ordinary project name untouched in both directions', () => {
    for (const name of ['Marina', 'AI Eureka', '50% done', 'a/b']) {
      expect(projectToUrl(name)).toBe(name);
      expect(projectFromUrl(projectToUrl(name))).toBe(name);
    }
  });

  it('links the Inbox by its name to the Inbox tab', () => {
    // The Inbox's own name is the Inbox: its link is the sentinel's token and reads back as the tab.
    for (const name of ['inbox', 'Inbox']) {
      expect(projectToUrl(name)).toBe('_inbox');
      expect(projectFromUrl(projectToUrl(name))).toBe(INBOX_TAB);
    }
  });

  it('escapes a real name that itself begins with the namespace char', () => {
    expect(projectToUrl('_inbox')).toBe('__inbox');
    expect(projectFromUrl('__inbox')).toBe('_inbox');
    expect(projectFromUrl(projectToUrl('_wip'))).toBe('_wip');
  });

  it('emits tokens that URLSearchParams does not percent-encode', () => {
    // '~' would serialize as %7E and churn the URL / break echo suppression.
    const sp = new URLSearchParams();
    sp.set('proj', projectToUrl(INBOX_TAB));
    expect(sp.toString()).toBe(`proj=${projectToUrl(INBOX_TAB)}`);
  });
});
