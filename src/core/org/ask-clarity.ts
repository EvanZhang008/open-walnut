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
 * ("where the notes live" is a storage question; "the token in the header" is not a screen; a bare
 * "card", "panel", "menu" or "screen" is a bank card, an interview panel, a lunch menu as often).
 */
const LOOK = /\b(?:mock-?up|colou?r scheme)\b|\u8bbe\u8ba1\u7a3f|\u914d\u8272|\u957f\u4ec0\u4e48\u6837/i;
const PLACE = /\b(?:where|position|placement|place|put|move|above|below)\b|\u4f4d\u7f6e|\u653e(?:\u5728|\u54ea|\u5230)|\u632a\u5230|\u79fb\u5230|\u4e0a\u9762\u8fd8\u662f\u4e0b\u9762|\u5de6\u8fb9\u8fd8\u662f\u53f3\u8fb9/i;
const SCREEN = /\b(?:button|tab|icon|sidebar|toolbar|title ?bar|sign-in entry|(?:settings|home|start|lock|login|sign-in) (?:screen|page|menu)|(?:context|dropdown|drop-down|app) menu)s?\b|\u6309\u94ae|\u5165\u53e3|\u6807\u7b7e\u9875|\u83dc\u5355|\u5361\u7247|\u56fe\u6807|\u9762\u677f|\u4fa7\u680f|\u5de5\u5177\u680f|\u6807\u9898\u680f|\u754c\u9762|\u9875\u9762/i;

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
export function reviewed(note: string, anywhere = false): boolean {
  const t = note.trim().slice(0, SCAN_MAX);
  if ((anywhere ? /(?:^|\W)small:\s*\S.{4,}/i : /^small:\s*\S.{4,}/i).test(t)) return true;
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
  return choiceShapes(raw).map((c) => c.label);
}

/** One choice as the user sees it: its label, the line under it, and whether it is the asker's pick. */
export interface ChoiceShape { label: string; detail?: string; recommended?: boolean }

/** The choices a caller passed, whatever their shape: strings, {label, detail | description, recommended}. */
export function choiceShapes(raw: unknown, kind?: unknown): ChoiceShape[] {
  // A yes/no ask's card shows these two keys (user-status.ts askAnswerText, org-ask-form.ts formOptions).
  if (kind === 'yes_no') return [{ label: 'Yes' }, { label: 'No' }];
  if (!Array.isArray(raw)) return [];
  const out: ChoiceShape[] = [];
  for (const o of raw.slice(0, 12)) {
    if (typeof o === 'string') { if (o.trim()) out.push({ label: o }); continue; }
    if (!o || typeof o !== 'object') continue;
    const r = o as { label?: unknown; detail?: unknown; description?: unknown; recommended?: unknown };
    if (typeof r.label !== 'string' || !r.label.trim()) continue;
    const detail = typeof r.detail === 'string' ? r.detail : typeof r.description === 'string' ? r.description : '';
    out.push({ label: r.label, ...(detail.trim() ? { detail } : {}), ...(r.recommended === true ? { recommended: true } : {}) });
  }
  return out;
}

/** A label that names its pick in its words ("Delete them (recommended)"), for a door with no flag. */
const RECOMMENDED_WORD = /[(\uff08](?:recommended|\u63a8\u8350)[)\uff09]|\u3010\u63a8\u8350\u3011/i;

/** A yes-or-no answer word: "Yes", "No", "Confirm", "Cancel", and the same in Chinese (\u662f, \u5426,
 *  \u4e0d\u8981, \u786e\u5b9a, \u53d6\u6d88, \u540c\u610f, ...). With VAGUE_LABEL ("OK", "Go") it makes a bare key. */
const YES_NO_WORD = /^(?:yes|no|y|n|yep|yeah|nope|confirm|cancel|\u662f|\u662f\u7684|\u5426|\u4e0d|\u4e0d\u8981|\u4e0d\u7528|\u8981|\u5bf9|\u786e\u5b9a|\u786e\u8ba4|\u53d6\u6d88|\u540c\u610f|\u4e0d\u540c\u610f|\u597d\u5427|\u6ca1\u95ee\u9898)$/i;

/** A key that says nothing of what a click does: its label is a yes-or-no or vague word once its
 *  pick mark, emoji and punctuation are off, and no line of its own says what it does. */
function bareKey(c: ChoiceShape): boolean {
  if (c.detail?.trim()) return false;
  const w = clean(c.label.replace(RECOMMENDED_WORD, ' '));
  return YES_NO_WORD.test(w) || VAGUE_LABEL.test(w);
}

/** A count of things a decision is about ("about 7 clusters", "\u7ea6 7 \u4e2a\u96c6\u7fa4"), which then needs their names. */
const COUNTED = /(?<![\p{L}\p{N}])(?:(?:about|around|roughly|nearly|over|some|~) ?)?(?:\d{1,3}\+?|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|a dozen|dozens of|several) (?:[\p{L}\p{N}-]{1,30} ){0,3}(?:clusters?|tickets?|CRs?|PRs?|pull requests?|accounts?|instances?|resources?|buckets?|hosts?|machines?|repos?|repositories|branches|stacks?|nodes|servers?|databases?|volumes?|keys?|secrets?|domains?|alarms?|pipelines?|deployments?)(?![\p{L}\p{N}])|(?:\u7ea6|\u5927\u7ea6|\u5927\u6982|\u8fd1|\u5171)?\s?\d{1,3}\s?(?:\u4e2a|\u6761|\u53f0|\u4efd|\u5957)\s?[\p{L}\p{N}-]{0,12}\s?(?:\u96c6\u7fa4|\u5de5\u5355|\u8d26\u53f7|\u5b9e\u4f8b|\u8d44\u6e90|\u673a\u5668|\u8282\u70b9|\u4ed3\u5e93|\u5206\u652f|\u6570\u636e\u5e93|\u5bc6\u94a5|\u57df\u540d|\u544a\u8b66|\u6d41\u6c34\u7ebf)/iu;
const MAKE = /\b(?:create|creating|add|adding|buy|buying|open|opening|make|making|set up|spin up|provision|provisioning|new)\b(?:\s+(?:the|a|another))?\s*$|(?:\u65b0\u5efa|\u521b\u5efa|\u65b0\u589e|\u5f00|\u4e70|\u52a0)\s*$/i;
/** Their names are there: a link, a path, a name in backticks, a list, or two names like "acme-1". */
const NAMED = /https?:\/\/|(?:^|\s)~?\/[\w.-]+\/|`[^`\n]{2,80}`|^[ \t]*(?:[-*\u2022]|\d{1,2}[.)])[ \t]+\S/m;
const NAME_TOKEN = /\b[a-z][a-z0-9]*(?:[-_.][a-z0-9]+)+\b/gi;

/** Under this much text (a CJK character counts as two) a card says what, not why: no background. */
export const THIN_CARD_MIN = 40;

function weight(text: string): number {
  const t = text.replace(/\s+/g, '');
  const cjk = (t.match(/[\u3400-\u9fff\uf900-\ufaff]/g) ?? []).length;
  return t.length + cjk;
}

/**
 * A card that hands the user a decision and leaves out what they need to make it, as the refusal, or
 * null (2026-11-23, the CEO's reflection on 11-22: "the cards that ask Evan to decide are bare Yes/No,
 * with no background"; a delete card with only [Yes] [No] and its pick second, an ops review that named
 * "about 7 clusters" with no names or links, an approval with no body):
 *   - the asker's pick is not the first choice;
 *   - (a card he reads on its own: `standalone`) too little text to say what it is and why it is his;
 *   - (`standalone`) it counts the things it is about ("7 clusters") without naming or linking them;
 *   - (`standalone`) its pick, or every key, says nothing of what a click does ([Yes] [No], [OK]) and has
 *     no line of its own that does (2026-11-24, the CEO's reflection on 11-23: "its buttons are only [Yes]
 *     [No] and do not say what a click does", a sign-in card; a yes/no ask counts as those two keys, `choiceShapes(raw, 'yes_no')`).
 * `text`: everything the user reads on the card. Pure.
 */
export function bareCardRefusal(text: string, choices: readonly ChoiceShape[], opts: { standalone?: boolean } = {}): string | null {
  const t = text.slice(0, SCAN_MAX);
  const pick = choices.findIndex((c) => c.recommended === true || RECOMMENDED_WORD.test(c.label));
  if (pick > 0) {
    return `Not sent to the user: your pick "${choices[pick]!.label}" is not the first choice. Put the option you recommend first `
      + '(marked recommended), then the others, so the user reads your pick before anything else.';
  }
  if (!opts.standalone) return null;
  if (weight(t) < THIN_CARD_MIN) {
    return 'Not sent to the user: the card says too little to decide on. The user has not seen this work: say what it is, what you '
      + 'recommend and why, what each choice does, and who else it touches (a colleague who must approve, a team), with the evidence by '
      + 'path or link.';
  }
  const counted = COUNTED.exec(t);
  // Things still to make ("create three test accounts") have no names yet.
  const toMake = counted && MAKE.test(t.slice(Math.max(0, counted.index - 40), counted.index));
  // "e.g." and "i.e." are no names.
  const names = (t.match(NAME_TOKEN) ?? []).filter((n) => n.length >= 5);
  if (counted && !toMake && !NAMED.test(t) && names.length < 2) {
    return `Not sent to the user: it counts "${counted[0].trim()}" without naming them. Name each one (or link the list) so the `
      + 'user can see what they are deciding about.';
  }
  // The pick a bare key, or every key bare: a "Cancel" beside "Push revision 2 now" reads fine.
  const bare = pick === 0 && bareKey(choices[0]!) ? choices[0] : choices.length && choices.every(bareKey) ? choices[0] : undefined;
  if (bare) {
    return `Not sent to the user: its button "${bare.label}" does not say what happens on a click. Make each choice name its `
      + 'result ("Push revision 2 now", "Keep it unpushed"; a single-choice ask, never yes-no), your pick first and marked recommended.';
  }
  return null;
}

/**
 * Why the question does not read on its own, or null. `question`: its title and question (where the
 * pointing words are judged); `detail`: the rest the user reads beside it (where a picture may be).
 */
export function askClarityRefusal(question: string, detail = '', labels: readonly string[] = [], review = '', opts: { reviewInText?: boolean; ownWords?: string; choices?: readonly ChoiceShape[]; standalone?: boolean } = {}): string | null {
  const q = question.slice(0, SCAN_MAX);
  const all = `${q}\n${detail.slice(0, SCAN_MAX)}`;
  const hasPicture = DESIGN.test(all);
  // A thread he opened carries his words as its title: only the writer's own words are judged bare.
  const bare = bareOpeningRefusal(opts.ownWords ?? q);
  if (bare) return bare;
  if (PLAN_PAGE.test(all) && !PATH_OR_LINK.test(all)) return PLAN_PAGE_REFUSAL;
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
  // Where the ask has no field of its own for it (a turn-end line, an AskUserQuestion), the review is named in its text.
  if (hasPicture && !reviewed(review) && !(opts.reviewInText && reviewed(all, true))) {
    const how = opts.reviewInText
      ? 'then name it in the text: "Reviewed: <model>, function N/10, experience N/10, interface N/10; <what changed>" (a text-only or colour-only change: "small: <what changed>").'
      : 'then pass design_review with the reviewer model, the three scores and what changed (for example "sol: function 8/10, experience 7/10, interface 6/10; fixed the window buttons over the menu icon"). Only a text-only or colour-only change skips this: design_review "small: <what changed>".';
    return 'Not sent to the user: it shows a design, image or page with no review on record. Start your own reviewer subagent on '
      + 'another model than the one that made it (Sol, where your Agent tool has it), have it check every picture once (overlaps, cut-off or '
      + `overflowing text, alignment, spacing, match with the real screen) and score function, experience and interface out of 10, fix what it found, ${how}`;
  }
  const vague = labels.find((l) => VAGUE_LABEL.test(clean(l)) || DEICTIC.test(l));
  if (vague) {
    return `Not sent to the user: the choice "${vague}" says nothing on its own. Name the result in each label `
      + '("Show the sign-in entry under All devices and ship"), so the user can pick without reading back.';
  }
  return bareCardRefusal(`${all}\n${(opts.choices ?? []).map((c) => c.detail ?? '').join('\n')}`, opts.choices ?? labels.map((label) => ({ label })), { standalone: opts.standalone === true });
}

/** A first sentence with no subject: "Go ahead with this plan? I recommend it." names nothing. */
const BARE_OPENING = /^(?:(?:\u8981\u4e0d\u8981|\u662f\u5426|\u8981|\u53ef\u4ee5)(?:\u6309|\u7167)?(?:\u8fd9\u4e2a|\u90a3\u4e2a|\u8fd9\u6837|\u6b64)?(?:\u65b9\u6848|\u8ba1\u5212|\u505a\u6cd5)?(?:\u505a|\u6765|\u529e|\u5f04|\u6539)?|(?:should|shall|can) (?:i|we) (?:do|go ahead with|proceed with|ship|start) (?:it|this|that|the plan)|go ahead(?: with (?:it|this|the plan))?|proceed|do it|ok|okay|\u884c\u4e0d\u884c|\u53ef\u4ee5\u5417|\u597d\u5417)\s*[?\uff1f.!\u3002\uff01]*$/i;

/** A plan or design page or document pointed at as one that exists ("see the plan page"), which then needs its path or link; one still to write ("write a design doc first") does not. */
const PLAN_PAGE = /(?:\u770b|\u89c1|\u6253\u5f00|\u8fd9\u4e2a|\u90a3\u4e2a|\u6309)\s*(?:\u65b9\u6848\u9875|\u8bbe\u8ba1\u9875|\u65b9\u6848(?:\u56fe|\u6587\u6863|\u7a3f))|\b(?:see|open|read|review|check|per|in|the|this|that|my) (?:plan|design|proposal|mockup) (?:page|doc(?:ument)?)\b/i;
const PATH_OR_LINK = /https?:\/\/[^\s"'<>)]{1,300}|(?:^|[^\w/.~-])~?\/[^\s"'<>)]{1,300}/;

/** A yes or no question, which then needs its choices as buttons. */
const YES_NO = /\u8981\u4e0d\u8981|\u662f\u5426|\u505a\u4e0d\u505a|\u884c\u4e0d\u884c|\u53ef\u4ee5\u5417|\u597d\u5417|^(?:should|shall|do|can|may) (?:i|we|you)\b|\bok to\b/i;

const PLAN_PAGE_REFUSAL = 'Not handed to the user: it names a plan or design page with no path to it. Put its absolute path (or link) beside it.';

/** A first sentence that names nothing ("Go ahead with this plan? I recommend it."), as the refusal, or null. */
function bareOpeningRefusal(text: string): string | null {
  let t = text.slice(0, SCAN_MAX).trim();
  // "OK. Merge PR 12 for the sync fix?": an "OK." alone opens, the next sentence asks.
  t = t.replace(/^(?:ok(?:ay)?|\u597d(?:\u7684)?)[.!\u3002\uff01]\s*(?=\S)/i, '');
  const first = firstSentence(t);
  if (!first || !BARE_OPENING.test(first)) return null;
  return `Not handed to the user: "${first}" names nothing. The user reads its first sentence first: say what they decide and what you `
    + 'recommend in it ("Store passkeys in the Walnut password extension? I recommend yes: ..."), then the key points and evidence paths.';
}

function firstSentence(text: string): string {
  const t = text.trim().split('\n').find((l) => l.trim()) ?? '';
  const m = /^.*?[?\uff1f.!\u3002\uff01](?=\s|$|[^?\uff1f.!\u3002\uff01])/u.exec(t.trim());
  return (m ? m[0] : t).trim().replace(/^[#>*\-\s]+/, '');
}

/**
 * A thread card that waits on him reads alone (2026-11-21, the user, of a card that showed only
 * "Go ahead with this plan? I recommend it." and "has not written a summary yet": "what the fucking
 * is the plan"): its summary's first sentence says what he decides and the recommendation, a plan or
 * design page is named by its path, and a yes or no question carries its choices as buttons.
 * `summary`: the card's summary (`reply`), or the opener when it has none. Null when it passes. Pure.
 */
export function needsCardRefusal(card: { title: string; summary: string; hasSummary: boolean; opener?: string; options: readonly string[] }): string | null {
  const summary = card.summary.slice(0, SCAN_MAX);
  const all = `${card.title}\n${summary}\n${(card.opener ?? '').slice(0, SCAN_MAX)}`;
  // With no summary the card shows the opener's first line only: what is below it is hidden from him.
  const opener = (card.opener ?? '').trim();
  if (!card.hasSummary && opener.split('\n').filter((l) => l.trim()).length > 1) {
    return 'Not handed to the user: the card has no summary, so it shows only the first line of your post. Write it (reply): the first '
      + 'sentence says what they decide and what you recommend, then the key points and the evidence by absolute path.';
  }
  for (const text of [summary, card.opener ?? '']) {
    const bare = bareOpeningRefusal(text);
    if (bare) return bare;
  }
  if (PLAN_PAGE.test(all) && !PATH_OR_LINK.test(all)) return PLAN_PAGE_REFUSAL;
  // The node's own words only: a thread he opened carries his question as its title.
  if (YES_NO.test(firstSentence(summary)) && card.options.length === 0) {
    return 'Not handed to the user: it asks a yes or no question with no buttons. Pass options, each naming its result, your pick first '
      + 'and marked recommended, so they answer in one tap instead of typing.';
  }
  return null;
}

/** A summary the user reads past this many characters is long (a card shows it whole). */
export const LONG_TEXT_CHARS = 700;

/**
 * Text written for the user that runs long with no picture (2026-11-20, the user: "no one wants to read
 * this much ... use pictures and GIFs, not big blocks of text"; four times in two days). Not a refusal:
 * the op's answer tells the writer to cut it. Null when it is short or carries a picture. Pure.
 */
export function longTextHint(text: string | undefined): string | null {
  const t = (text ?? '').trim();
  if (t.length <= LONG_TEXT_CHARS || DESIGN.test(t.slice(0, SCAN_MAX))) return null;
  return `This is ${t.length} characters, long for the user to read. Cut it to the answer first and a few lines, `
    + 'put a picture, table or GIF in place of a block of text, and move detail to a file by its path.';
}

/**
 * The doors with no field for a review or a refusal of their own (2026-11-21, the user: "I think you
 * write it well, but the ones below do not"; the workers' asks reach him through these):
 *   - a task's turn-end lines (FOR_USER_ASK, _ASK_MORE, _ASK_OPTIONS; status-question.ts asks it to
 *     write them again once, with the reason);
 *   - an AskUserQuestion prompt (its PreToolUse hook denies it with the reason, ops/link-check.ts);
 *   - a new Board choice (refused 409, its title and option labels: the page around it is its picture).
 * A review of a picture is named in the text itself ("Reviewed: sol, function 8/10, ...").
 */
export function turnEndAskRefusal(r: { state?: string; ask?: string; ask_more?: string; ask_kind?: string; ask_options?: ReadonlyArray<{ label: string; detail?: string; recommended?: boolean }> }): string | null {
  if (r.state !== 'needs' || !r.ask?.trim()) return null;
  return askClarityRefusal(r.ask, r.ask_more ?? '', (r.ask_options ?? []).map((o) => o.label), '', { reviewInText: true, choices: choiceShapes(r.ask_options, r.ask_kind), standalone: true });
}

/** One AskUserQuestion question as the tool takes it. */
interface ToolQuestion { question?: unknown; header?: unknown; options?: unknown }

export function askUserQuestionRefusal(toolInput: unknown): string | null {
  const qs = (toolInput as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(qs)) return null;
  const s = (v: unknown): string => (typeof v === 'string' ? v : '');
  for (const q of qs.slice(0, 8) as ToolQuestion[]) {
    const opts = Array.isArray(q?.options) ? (q.options as Array<{ label?: unknown; description?: unknown; preview?: unknown }>) : [];
    const detail = opts.map((o) => `${s(o?.description)}\n${s(o?.preview)}`).join('\n');
    // In the chat, beside the work it is about: no background or names asked, only what each choice does.
    const why = askClarityRefusal(`${s(q?.question)}\n${s(q?.header)}`, detail, opts.map((o) => s(o?.label)).filter(Boolean), '', { reviewInText: true, choices: choiceShapes(opts) });
    if (why) return why;
  }
  return null;
}

export function boardChoiceRefusal(title: string, labels: readonly string[]): string | null {
  const t = title.slice(0, SCAN_MAX);
  const pointing = [t, ...labels].find((x) => DEICTIC.test(x));
  if (pointing) {
    return `Not added: the choice points at a place only you can see ("${DEICTIC.exec(pointing)![0]}"). It also reaches the user as a thread `
      + 'card on its own, away from the Board: say in its title what the thing is and where it goes.';
  }
  const bare = bareOpeningRefusal(t);
  if (bare) return bare;
  const vague = labels.find((l) => VAGUE_LABEL.test(clean(l)));
  if (vague) return `Not added: the option "${vague}" says nothing on its own. Name the result in each label, so the user can pick without reading back.`;
  return null;
}
