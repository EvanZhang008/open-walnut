/**
 * What a letter id written in agent text looks like (`lt-mvx2abcd-9f3k`).
 *
 * The store's own shape (`LETTER_ID_RE` in src/core/human-inbox/normalize.ts),
 * bounded on both sides so a longer token never matches. One source for the
 * browser's markdown pass (web/src/utils/letter-links.ts) and the server's
 * letter body linker (src/lib/agent-text-refs.ts). Zero imports: the markdown
 * test tier runs it in a bare node env.
 */
export const LETTER_ID_SRC = '(?<![\\w./-])lt-[0-9a-z]{1,12}-[0-9a-z]{4,12}(?![\\w-])';

/** `letter:<letter id>` as a link destination (markdown `[x](letter:lt-…)`, an `<a href>`). */
export const LETTER_HREF_SRC = '^letter:(lt-[0-9a-z]{1,12}-[0-9a-z]{4,12})$';
