/**
 * A question for the user reads on its own (2026-11-21, the user, of a Needs you card titled "Wi-Fi
 * browser sign-in entry under All devices, ok?" whose body was "Put it in this position, ok?" and
 * whose button was "Put it here, ship": "they even ask me put here ok? what is here? can u make sure
 * walnut don't make this stupid mistake"). He had never seen the task; nothing said what the feature
 * was or where "here" was, and no picture showed it.
 *
 * So a question an agent hands the user (the same three doors user_kind guards: a thread waiting on
 * him, a decision letter, a task's Needs you set by a call) is refused when:
 *   - it points at a place with words that need context ("here", "this position", the Chinese
 *     equivalents) and carries no picture or link to point at;
 *   - it asks where something goes or how it looks and carries no picture (a screenshot or a design
 *     page, by absolute path or URL);
 *   - a choice's label says nothing on its own ("OK", "Go", "Put it here"): a label names the result;
 *   - it shows a design or picture with no `design_review` note (who looked, what they checked).
 * The charter's ask-once bullet says the same in words (answered-there.ts). Pure.
 */

/** At most this much of each text is read: the checks run on the server's event loop. */
const SCAN_MAX = 4_000;

/** Words that point at a place only the asker can see (narrow: "this position" can be a job offer). */
const DEICTIC = /\b(?:(?:put|place|move) (?:it |them )?(?:here|there)|(?:right|over) here|here,? (?:ok|okay|fine|good)\?|(?:this|that) spot|this one here)\b|\u653e(?:\u5728)?(?:\u8fd9\u91cc|\u8fd9\u513f|\u90a3\u91cc|\u90a3\u513f|\u8fd9\u8fb9|\u90a3\u8fb9)|(?:\u8fd9|\u90a3)\u4e2a\u4f4d\u7f6e/i;

/**
 * A question about how something on screen looks, or where it goes: a place word beside a screen noun
 * ("where the notes live" is a storage question; "the token in the header" is not a screen).
 */
const LOOK = /\b(?:mock-?up|colou?r scheme)\b|\u8bbe\u8ba1\u7a3f|\u914d\u8272|\u957f\u4ec0\u4e48\u6837/i;
const PLACE = /\b(?:where|position|placement|place|put|move|above|below)\b|\u4f4d\u7f6e|\u653e(?:\u5728|\u54ea|\u5230)|\u632a\u5230|\u79fb\u5230|\u4e0a\u9762\u8fd8\u662f\u4e0b\u9762|\u5de6\u8fb9\u8fd8\u662f\u53f3\u8fb9/i;
const SCREEN = /\b(?:button|tab|menu|card|icon|panel|sidebar|toolbar|title ?bar|screen|sign-in entry)s?\b|\u6309\u94ae|\u5165\u53e3|\u6807\u7b7e\u9875|\u83dc\u5355|\u5361\u7247|\u56fe\u6807|\u9762\u677f|\u4fa7\u680f|\u5de5\u5177\u680f|\u6807\u9898\u680f|\u754c\u9762|\u9875\u9762/i;

/**
 * A picture to look at, which is also what a design is: an image, video or HTML page by absolute path,
 * an image or video link, a Markdown image, an <img> or an inline image. Bounded, never `\S+` (an
 * unanchored `\S+\.png` scans a long token quadratically).
 */
const DESIGN = /(?:^|[^\w/.~-])~?\/[^\s"'<>)]{1,300}\.(?:png|jpe?g|gif|webp|svg|mp4|mov|webm|html?)\b|https?:\/\/[^\s"'<>)]{1,300}\.(?:png|jpe?g|gif|webp|svg|mp4|mov|webm)\b|!\[[^\]\n]{0,200}\]\([^)\n]{1,300}\)|<img\b|data:image\//i;

/**
 * A review on record: the reviewer's model and its three scores (the user, 2026-11-21: "Shoudl be
 * part of the task, with a differnet model, we can use sol", then "rate it"), or "small: <what changed>".
 */
export function reviewed(note: string): boolean {
  const t = note.trim().slice(0, SCAN_MAX);
  if (/^small:\s*\S.{4,}/i.test(t)) return true;
  const model = /\b(?:sol|astra|luna|gpt[-\w.]{0,20}|opus|sonnet|haiku|fable|gemini|codex)\b/i.test(t);
  const scores = (t.match(/\b(?:10|\d)(?:\.\d)?\s*(?:\/|out of)\s*10\b/gi) ?? []).length;
  return model && scores >= 3;
}

/** Whether a text shows a design or picture (an ask already handed over with one was reviewed then). */
export function showsDesign(text: string): boolean {
  return DESIGN.test(text.slice(0, SCAN_MAX));
}

/** Choice labels that say nothing on their own, once emoji, arrows and brackets are taken off. */
const VAGUE_LABEL = /^(?:ok(?:ay)?|go|go ahead|sure|fine|do it|do it now|lgtm|looks good|this|that|here|there|this one|that one|\u597d(?:\u7684)?|\u884c|\u53ef\u4ee5|\u5c31\u8fd9\u6837|\u8fd9\u6837|\u8fd9\u4e2a)$/i;

function clean(s: string): string {
  const words = (t: string) => t.replace(/[^\p{L}\p{N}\s'-]+/gu, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  // "OK (recommended)" is "ok"; "(OK)" is "ok" too.
  return words(s.replace(/\([^)]*\)/g, ' ')) || words(s);
}

/** The labels of the choices a caller passed, whatever their shape (strings, {label}). */
export function choiceLabels(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((o) => (typeof o === 'string' ? o : o && typeof o === 'object' && typeof (o as { label?: unknown }).label === 'string' ? (o as { label: string }).label : ''))
    .filter(Boolean);
}

/**
 * Why the question does not read on its own, or null. `question`: its title and question (where the
 * pointing words are judged); `detail`: the rest the user reads beside it (where a picture may be).
 */
export function askClarityRefusal(question: string, detail = '', labels: readonly string[] = [], review = ''): string | null {
  const q = question.slice(0, SCAN_MAX);
  const all = `${q}\n${detail.slice(0, SCAN_MAX)}`;
  const hasPicture = DESIGN.test(all);
  const pointing = [all, ...labels].find((t) => DEICTIC.test(t));
  if (pointing && !hasPicture) {
    return `Not sent to the user: the question points at a place only you can see ("${DEICTIC.exec(pointing)![0]}"). `
      + 'The user has not seen this task: say what the thing is and where exactly it goes in words they can follow without it, '
      + 'and attach a screenshot or the design page (an absolute path).';
  }
  if ((LOOK.test(q) || (PLACE.test(q) && SCREEN.test(q))) && !hasPicture) {
    return 'Not sent to the user: the question is about where something goes on screen or how it looks, and carries no picture. '
      + 'Attach a screenshot or the design page (an absolute path), and say what the feature is in one line.';
  }
  // A design shown to him was looked at once by a reviewer on another model (2026-11-21, the user,
  // after a title bar mockup whose window buttons sat on the menu icon: "The design need ot be at
  // least reviewed once"). A text-only or colour-only change says so: "small: <what changed>".
  if (hasPicture && !reviewed(review)) {
    return 'Not sent to the user: it shows a design, image or page with no review on record. Start your own reviewer subagent on '
      + 'another model than the one that made it (Sol, where your Agent tool has it), have it check every picture once (overlaps, cut-off or '
      + 'overflowing text, alignment, spacing, match with the real screen) and score function, experience and interface out of 10, '
      + 'fix what it found, then pass design_review with the reviewer model, the three scores and what changed (for example '
      + '"sol: function 8/10, experience 7/10, interface 6/10; fixed the window buttons over the menu icon"). Only a text-only '
      + 'or colour-only change skips this: design_review "small: <what changed>".';
  }
  const vague = labels.find((l) => VAGUE_LABEL.test(clean(l)) || DEICTIC.test(l));
  if (vague) {
    return `Not sent to the user: the choice "${vague}" says nothing on its own. Name the result in each label `
      + '("Show the sign-in entry under All devices and ship"), so the user can pick without reading back.';
  }
  return null;
}
