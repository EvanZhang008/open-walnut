/**
 * pending-markup — where a streamed reply ends inside an UNFINISHED markup
 * construct, so no surface ever renders half of one.
 *
 * Why this exists (reported 2026-08-31, inc-1788209680147): the CLI emitted a
 * `commands_changed` system line in the middle of an assistant message. Every
 * mirror of the streaming accumulator handles an interruption the same way —
 * flush what we have into a block, then RESET the accumulator so the text that
 * follows starts a new block after the card. The model happened to be one
 * character into an attribute at that moment, so the flushed block ended with
 *
 *     …<div style="border-left:3px solid #dc2626;padding:8
 *
 * and the next block began with `px">全部降级为基线…`. The first rendered as an
 * empty coloured pill (the sanitizer closes the tag it was handed), the second
 * rendered the rest of the attribute as visible prose. One sentence, cut in half,
 * permanently.
 *
 * The fix is to treat an unfinished construct as belonging to the text that
 * CONTINUES it: the interrupt flush renders `safe` and keeps `pending` in the
 * accumulator, so the tag arrives whole in the block after the card.
 *
 * Deliberately self-contained (no imports): the browser reducer
 * (web/src/stream/stream-reducer.ts) and the server-side buffer twin
 * (src/web/session-stream-buffer.ts) both call THIS module, because a rule that
 * only one of them applies shows up as "the artifact comes back after a reload".
 *
 * Scope note: web/src/utils/rich-blocks.ts has a much richer HTML scanner, but it
 * answers a different question (where may a chunk boundary fall, per line, with
 * element depth). This one answers only "does the text end mid-construct, and
 * where did that construct start". tests/core/pending-markup.test.ts cross-checks
 * the two so they cannot drift on the shared cases.
 */

/** Elements whose body is raw text: nothing inside them is markup, and only
 *  their own closer ends them. An unterminated one holds no renderable content. */
const RAWTEXT_TAGS = new Set(['style', 'script', 'textarea', 'title']);

/** `<https://x>`, `<mailto:a@b>` — markdown autolinks, not elements. */
const AUTOLINK_SCHEME_RE = /^<\/?[a-z][a-z0-9+.-]*:/i;

const TAG_NAME_RE = /^<\/?([a-zA-Z][a-zA-Z0-9:-]*)/;

/**
 * Ranges markdown renders as code, where a `<` is a SAMPLE and not markup.
 *
 * Same two rules the renderer follows: a fence of 3+ backticks/tildes is closed
 * only by the same character at >= its own length (so a ````-wrapped ``` sample
 * stays protected), and an unclosed fence runs to the end of the text. Inline
 * code spans use a run of N backticks closed by the next run of exactly N.
 */
function codeRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const lines = text.split('\n');
  let pos = 0;
  let fence: { char: string; len: number; start: number } | null = null;

  for (const line of lines) {
    const m = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (m && m[1][0] === fence.char && m[1].length >= fence.len) {
        ranges.push([fence.start, pos + line.length]);
        fence = null;
      }
    } else if (m) {
      fence = { char: m[1][0], len: m[1].length, start: pos };
    }
    pos += line.length + 1;
  }
  if (fence) ranges.push([fence.start, text.length]);

  // Inline code, skipping anything already inside a fence.
  const inFence = (at: number) => ranges.some(([s, e]) => at >= s && at < e);
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '`' || inFence(i)) continue;
    let run = 0;
    while (text[i + run] === '`') run++;
    const marker = '`'.repeat(run);
    // The closer must be a run of EXACTLY this length.
    let search = i + run;
    let close = -1;
    while (search < text.length) {
      const at = text.indexOf(marker, search);
      if (at < 0) break;
      let after = 0;
      while (text[at + marker.length + after] === '`') after++;
      let before = 0;
      while (text[at - 1 - before] === '`') before++;
      if (after === 0 && before === 0) { close = at; break; }
      search = at + marker.length + after;
    }
    if (close < 0) { i += run - 1; continue; } // unclosed inline run is literal
    ranges.push([i, close + marker.length]);
    i = close + marker.length - 1;
  }

  return ranges.sort((a, b) => a[0] - b[0]);
}

/** End index (exclusive) of the tag opened at `start`, or -1 while it is still
 *  arriving. Quote-aware, so a `>` inside an attribute cannot end it early. */
function tagEnd(text: string, start: number): number {
  let quote: string | null = null;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '>') return i + 1;
  }
  return -1;
}

/**
 * Split `text` at the start of a trailing unfinished markup construct.
 *
 * `pending` is empty for the overwhelmingly common case (the text ends on a
 * renderable boundary). When it is non-empty it is always a suffix of `text`, so
 * `safe + pending === text` always holds — callers can carry it forward without
 * losing a character.
 *
 * Recognised as unfinished: an opening or closing tag with no `>` yet, an HTML
 * comment with no `-->`, and a rawtext element (`<style>`, `<script>`) with no
 * closer. Prose that merely looks like a tag is NOT withheld: `a < b` (no name
 * after the `<`), `<https://…>` and `<user@host>` (autolinks), and anything
 * inside code.
 */
export function splitPendingMarkup(text: string): { safe: string; pending: string } {
  if (!text || !text.includes('<')) return { safe: text, pending: '' };

  const code = codeRanges(text);
  const inCode = (at: number) => code.some(([s, e]) => at >= s && at < e);

  let i = 0;
  let pendingAt = -1;

  while (i < text.length) {
    const lt = text.indexOf('<', i);
    if (lt < 0) break;
    if (inCode(lt)) { i = lt + 1; continue; }

    const rest = text.slice(lt);

    // Comment: only `-->` ends it.
    if (rest.startsWith('<!--')) {
      const close = text.indexOf('-->', lt + 4);
      if (close < 0) { pendingAt = lt; break; }
      i = close + 3;
      continue;
    }
    // A bare `<` (or `</`) at the very end is the beginning of a tag whose name
    // has not arrived — withholding one or two characters for one flush beats
    // rendering them as prose and then never being able to take them back.
    if (rest === '<' || rest === '</') { pendingAt = lt; break; }

    const name = TAG_NAME_RE.exec(rest)?.[1];
    if (!name) { i = lt + 1; continue; } // `a < b`, `<3`, …

    const end = tagEnd(text, lt);
    if (end < 0) {
      // Still arriving. An autolink or an email is prose, and both are short
      // enough that waiting for the `>` costs nothing either way — but they must
      // not be treated as ELEMENTS, so check the completed forms only below.
      pendingAt = lt;
      break;
    }
    const raw = text.slice(lt, end);
    if (AUTOLINK_SCHEME_RE.test(raw) || (!/\s/.test(raw) && raw.includes('@'))) {
      i = end;
      continue;
    }
    if (RAWTEXT_TAGS.has(name.toLowerCase()) && raw[1] !== '/') {
      const closer = new RegExp(`</${name}\\s*>`, 'i').exec(text.slice(end));
      if (!closer) { pendingAt = lt; break; }
      i = end + closer.index + closer[0].length;
      continue;
    }
    i = end;
  }

  if (pendingAt < 0) return { safe: text, pending: '' };
  return { safe: text.slice(0, pendingAt), pending: text.slice(pendingAt) };
}
