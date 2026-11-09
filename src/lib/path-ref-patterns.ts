/**
 * The absolute file path shape agents write in prose (`/repo/src/x.ts:42`,
 * `~/notes/H1 2026 Overview.md`), as regex SOURCES.
 *
 * Moved verbatim from web/src/utils/markdown.ts, which imports them back, so the
 * browser's markdown passes and the server's letter body linker
 * (src/lib/agent-text-refs.ts) share one definition. Pure, no imports: the
 * markdown test tier runs this in a bare node env. Build a fresh
 * `new RegExp(SRC, flags)` per use; never share a global regex.
 */

// ── Path segments that may contain SPACES (e.g. notes: "H1 2026 Overview.md") ──
// A segment is word-chunks joined by single spaces (CJK chars allowed — note
// filenames are often Chinese). Space-joined chunks are only trusted when:
//  - the whole match is anchored by a final `.ext`, AND
//  - each chunk after a space is one of: uppercase/digit/CJK-started word (Title
//    Case or year-prefixed note names), a dash separator (- – —), a parenthesized
//    tag like "(draft)", or a lowercase TITLE CONNECTOR from a closed word list
//    ("to", "with", "of", …) that must be followed by another chunk, so a
//    connector can never end the filename. A closed list — not "any short
//    lowercase word" — keeps prose after a path from being swallowed. Personal AI
//    notes use sentence-style titles like "2026-08-08 – Status Ping to Acme
//    (draft).md" and "Reply to X with Resume (draft).md" — all shapes occur.
//  - the chunk quantifier is LAZY: the shortest match that still reaches `.ext`
//    wins, so a real path followed by Title-Case prose ("see /a/b.md See
//    Section 2.5") stops at `b.md` instead of swallowing the sentence.
export const PATH_CH = '[\\w@.+\\-\\u2013\\u2014\\u4e00-\\u9fff\\u3040-\\u30ff]';
export const PATH_SEG = `${PATH_CH}+`;
// Chunk words after a space must be DOT-FREE. With dots allowed, backtracking
// order bites: a chunk greedily eats "Overview.md", the terminal `\.ext` fails,
// and the engine tries ADDING chunks before shrinking the current one — so the
// match runs past the real filename to the next `.ext` in following prose
// ("…Overview.md and Other Notes.md" became one link). Dot-free chunks stop at
// the dot, so the terminal `.ext` is checked at every chunk boundary first.
export const CHUNK_CH = '[\\w@+\\-\\u2013\\u2014\\u4e00-\\u9fff\\u3040-\\u30ff]';
export const TITLE_CONNECTOR = '(?:to|of|in|on|at|for|and|or|the|an?|with|without|vs|via|from|by|as|per|re)';
export const PATH_SP_CHUNK = `(?:(?=[A-Z0-9\\u4e00-\\u9fff\\u3040-\\u30ff])${CHUNK_CH}+|[-\\u2013\\u2014]+|\\(${PATH_CH}+\\)|${TITLE_CONNECTOR}(?= ))`;
// {0,9} bounds backtracking (a 10+-word segment is prose, not a filename); lazy
// so the shortest expansion that reaches `.ext` wins.
export const PATH_SEG_SP = `${PATH_SEG}(?: ${PATH_SP_CHUNK}){0,9}?`;
/**
 * Where an absolute path may START. Not after a word character or `/` (the middle
 * of `src/providers/foo.ts`, or a URL's path), and not after a `./` or `../`
 * token (`../lib/x.ts` is RELATIVE: read as `/lib/x.ts` it opened a file that has
 * nothing to do with the reference; `e.g./tmp/x.md` still links). Shared by the
 * file and directory passes, prose and code.
 */
export const ABS_START = '(?<![\\/\\w])(?<!(?:^|\\W)\\.{1,2})';
/** In code, also not after `word:`: `host:/etc/x.conf`, `-v /src:/app/x.conf`,
 *  `C:/Users/x.ts` and the tail of a `PATH=a:b` list name another machine, a
 *  container or a search path, not a file on this host. Prose keeps `Output:/x`. */
export const ABS_START_CODE = `${ABS_START}(?<!\\w:)`;

/**
 * The position a bare path may carry, linked WITH the path so a range is never
 * cut at its first number (`object.go:31-34` used to link up to `:31` and leave
 * `-34` outside). Exactly the suffixes parsePathRef reads, most specific first:
 * `#L10-L20`, `#L42`/`#42`, `:10-20`, `:42:7`, `:L42`, `:42`, `(42,7)`, `(42)`.
 * A `#` form must end there: `guide.md#2-setup` is a heading anchor, not line 2.
 * One capture group; positionAttrs turns it into anchor attributes.
 */
export const POS_SUFFIX_SRC = '(#L\\d+[-\\u2013]L?\\d+(?![\\w-])|#L?\\d+(?![\\w-])|:\\d+[-\\u2013]\\d+|:\\d+:\\d+|:L\\d+|:\\d+|\\(\\d+,[ \\t]*\\d+\\)|\\(\\d+\\))?';

/** Absolute FILE path source, spaces allowed: /dir/My Dir/H1 2026 File.md(:line).
 * The leaf is an ORDERED alternation `(?:PATH_SEG|PATH_SEG_SP)`: the space-free
 * alternative is exhausted (including greedy-shrink) BEFORE any space-chunk
 * expansion is tried, so "renamed /a/b/c.md to Other Steps.md" stops at `c.md`.
 * PATH_SEG_SP alone fails there: after its greedy first word eats "c.md" and the
 * terminal `\.ext` fails, backtracking expands the (more recent) chunk quantifier
 * before shrinking the first word — running the match into the following prose.
 * Build a fresh `new RegExp(ABS_FILE_RE_SRC, 'g')` per use — shared global regexes
 * carry lastIndex state across callers. */
export const ABS_FILE_BODY_SRC = `(~?\\/(?:${PATH_SEG_SP}\\/)+(?:${PATH_SEG}|${PATH_SEG_SP})\\.[\\w]+)${POS_SUFFIX_SRC}`;
export const ABS_FILE_RE_SRC = `${ABS_START}${ABS_FILE_BODY_SRC}`;
export const ABS_FILE_CODE_RE_SRC = `${ABS_START_CODE}${ABS_FILE_BODY_SRC}`;
