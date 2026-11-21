/**
 * Shared constants for the task panel's project tab strip.
 *
 * Project is the single grouping layer. The Inbox is a project of its own
 * (`Inbox`), but older rows, saved tabs and links still name it `''`, so the
 * tab strip keeps ids that can never collide with a real project name:
 *
 *   • `''`          — the **All** chip (no project scoping). Already unavailable
 *                     to a real project: a blank name is rejected server-side.
 *   • INBOX_TAB     — the no-project bucket, since `''` is taken by All.
 *
 * INBOX_TAB is a Unicode **private-use** codepoint on purpose. It used to be
 * U+2205 (empty-set sign), which is typeable — a project literally named with
 * that character became indistinguishable from the Inbox chip. Private-use
 * codepoints have no keyboard/IME path and no meaning in any script, so
 * `name.trim()` off a text input can't realistically produce one.
 */

// Relative import: unit tests load this module without the @open-walnut aliases.
import { isInboxProject } from '../../../../src/core/inbox-project';

/**
 * Inbox chip (tasks with no project). U+E000 = the first Unicode private-use
 * codepoint; see the collision note above. Rendered with the label "Inbox".
 */
export const INBOX_TAB = '\uE000';

/** A project's tab id: the Inbox (by name or by an older empty value) is INBOX_TAB. */
export function tabOfProject(project: string | null | undefined): string {
  return isInboxProject(project) ? INBOX_TAB : (project ?? '');
}

/**
 * localStorage key for the active project tab. Shared so MainPage's initial read
 * and TodoPanel's writes can't drift apart (they were two different literals
 * until 2026-08).
 *
 * The `walnut-todo-` prefix is load-bearing: `web/src/utils/crash-recovery.ts`
 * clears exactly the `open-walnut-` and `walnut-todo-` prefixes when a repeated
 * render crash is detected, so renaming this key would drop it out of crash
 * recovery.
 */
export const LS_TAB_KEY = 'walnut-todo-active-tab';

// ── `?proj=` URL encoding ──────────────────────────────────────────────────
//
// The raw sentinel doesn't belong in a URL (the private-use Inbox codepoint
// doesn't survive copy/paste), so it gets a readable token.
//
// The token is NAMESPACED with a leading '_' (`_inbox`), and the whole '_'
// prefix is reserved: a real project name that starts with '_' is escaped by
// doubling it ('_wip' → '__wip'). That makes the mapping total and INJECTIVE, so
// every project — including one named "inbox", which is a perfectly legal name
// (project names are only case-insensitively unique, never reserved) — survives
// a deep-link round trip.
//
// The old scheme wrote the BARE token 'inbox'. Since the Inbox became a project
// named "Inbox" (any case names it), a bare 'inbox' or 'Inbox' token names the
// Inbox again, and reads back as the INBOX_TAB sentinel; the written token stays
// '_inbox'.
//
// The retired ★ tab's token ('_starred') is likewise not accepted: the starred
// system is gone, so such a link self-heals to All like any other stale tab.
//
// Why '_' and not '~': URLSearchParams serializes form-encoded, which escapes
// '~' to %7E. That would leak an encoded token into every shared link and make
// useUrlSync's echo-suppression compare fight a hand-typed '~'. '_' is left
// verbatim by form encoding.

const SENTINEL_URL: Record<string, string> = {
  [INBOX_TAB]: '_inbox',
};

const URL_SENTINEL: Record<string, string> = {
  _inbox: INBOX_TAB,
};

/** A non-empty project name that names the Inbox ('' stays the All tab). */
const namesInbox = (name: string): boolean => name.trim() !== '' && isInboxProject(name);

/** Internal tab id → its `?proj=` token. */
export function projectToUrl(project: string): string {
  const token = SENTINEL_URL[namesInbox(project) ? INBOX_TAB : project];
  if (token) return token;
  // Reserve the whole '_' namespace for sentinels: a real name starting with '_'
  // is escaped by doubling so it can't be read as (or shadow) a token.
  return project.startsWith('_') ? `_${project}` : project;
}

/** `?proj=` token → internal tab id. Inverse of projectToUrl for every input. */
export function projectFromUrl(val: string): string {
  if (val.startsWith('__')) return val.slice(1);
  const sentinel = URL_SENTINEL[val];
  if (sentinel !== undefined) return sentinel;
  return namesInbox(val) ? INBOX_TAB : val;
}
