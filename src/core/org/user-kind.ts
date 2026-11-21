/**
 * Which of the user's own kinds a question for them is (2026-11-01, the user: "why ask me, just go,
 * make your decision ... this is not an important question, if they eventually pop up to you you
 * should make the decision, what is important and what is not"). A simulator test had overwritten
 * the user's installed app; the task asked whether to put the main build back, and its lead handed
 * that to the user as a thread waiting on them. The charter already said "asked something you can
 * decide, decide it" and so did USER.md, and both escalated anyway: text alone did not hold.
 *
 * So the line a lead or Main crosses to hand the user a question is checked by Walnut: an
 * `action_required` letter from a task session (Main, a lead or a worker), and a Thread an agent moves to
 * `needs` (or opens waiting on them), carries `user_kind` (one of USER_KINDS) and `user_kind_why` (one line saying
 * what in THIS question makes it that kind). Without them it is refused (409 `user_kind`), with the
 * kinds and the kinds that are never the user's spelled out. The refusal makes the node ask itself
 * the question once; a node that cannot name a kind decides, and tells its team. With them, the kind
 * and the reason lead the letter, so the user reads why it is theirs.
 *
 * The turn-end self-report is judged the same way (session-hooks/builtins.ts readStatusReport): a
 * FOR_USER_ASK with no FOR_USER_ASK_OWN kind reads as a report to the task's lead, and a line set from
 * outside the turn (sessions/report-set.ts) by a task needs the kind or gets 409.
 *
 * A fixed list rather than free text: a model that wants to ask can always write a reason, but it
 * has to pick a kind, and "undoing my own mess" or "choosing between two fine options" has none.
 * The kinds mirror the team charter (team-charter.ts) and the approval rules (answer-approval.ts).
 */
import { askClarityRefusal } from './ask-clarity.js';
import type { LetterLang } from '../human-inbox/walnut-letters/languages.js';
import { USER_KIND_LEAD_WORDS } from '../human-inbox/walnut-letters/thread-words.js';

export const USER_KINDS = [
  'outward', 'spending', 'credentials', 'permissions', 'cloud_delete', 'irreversible', 'user_info', 'user_own',
] as const;
export type UserKind = (typeof USER_KINDS)[number];

/** What each kind means, in the words the refusal and the letter use. */
export const USER_KIND_WORDS: Readonly<Record<UserKind, string>> = {
  outward: 'a message, post, reply or ping to people, a sign-up, meeting, invite or application in the user\'s name, a public push, publish or release, or anything leaving the team\'s own code; not a code change, commit or change request in the team\'s own repo/package',
  spending: 'spending money or quota that is not already budgeted',
  credentials: 'a credential, key or sign-in',
  permissions: 'a permission, access or setting that widens what an agent may do',
  cloud_delete: 'deleting cloud resources or data',
  irreversible: 'a choice that is hard to reverse and no existing rule covers',
  user_info: 'a fact, preference or access only the user has and nothing readable shows',
  user_own: 'the user\'s own matter: their mail, calendar or people, something they asked to decide or follow, or doing less than they asked (a part of the scope they set left out)',
};


/** Shortest `user_kind_why` (the `snooze_reason` floor). */
export const USER_KIND_WHY_MIN = 10;

/** The rule in one paragraph, for the refusal, the op help and the core instructions. */
export const NOT_THE_USERS_DECISION =
  'Never the user\'s: undoing something an agent broke or changed (a build, an install, a test run, a file), choosing between '
  + 'reasonable options, anything reversible, and a question whose answer you can read or try. Decide those, do them, and tell '
  + 'your team (or the user, in a line afterwards) what you chose. A code change, commit, or opening or publishing a change request '
  + 'in the team\'s own repo/package is team work, not outward; messages to people, public pushes and steps outside that code still need the user\'s words.';

/**
 * Correct a mistaken outward label only for explicitly owned code work. Both the ask and its
 * reason matter; the full details are checked too. Unclear ownership or any protected step keeps
 * the approval gate. This never changes another approval kind or authorizes the code operation.
 */
export function isTeamCodeAsk(ask: string | undefined, why: string | undefined, more?: string): boolean {
  const question = str(ask);
  const reason = str(why);
  if (!question || !reason || str(more)) return false;
  // A closed grammar, not a keyword blacklist: an unrecognized clause, destination or detail
  // keeps the gate. Finding "CR" somewhere in an email/push ask must never make it team work.
  const owned = "(?:the team's own|our own|our team's own) (?:repo(?:sitory)?|package|code(?:base)?)";
  const review = '(?:change request|code review|pull request|CR|PR)';
  const patch = '(?:(?:logging )?(?:fix|patch|code)|code work)';
  const scope = `(?: in ${owned})?`;
  const codeQuestion = new RegExp(`^(?:(?:Open|Create|Publish|Submit) (?:a |the )?${review}|(?:Commit|Change|Edit|Fix|Modify) (?:a |the )?${patch})${scope}\\?$`, 'i');
  const codeReason = new RegExp(`^It (?:(?:publishes|opens|creates|submits) (?:a |the )?${review}|(?:commits|edits|changes) (?:a |the )?${patch})${scope}(?: for review)?\\.?$`, 'i');
  const chineseQuestion = /^(?:\u5728\u56e2\u961f\u81ea\u5df1\u7684\u4ed3\u5e93\u63d0\u4ea4\u4ee3\u7801\u5ba1\u67e5\uff0c\u53ef\u4ee5\u5417\uff1f|\u6211\u6765\u5f00\u4e2a\u5c0f\u6539\u52a8\uff0c\u628a [A-Z][a-z]{1,20}(?: [A-Z][a-z]{1,20})? \u65e5\u5fd7\u91cc\u7684[\u4e00-\u9fff]{2,8}\u914d\u7f6e\u53bb\u6389\uff08\u53ea\u6539\u65e5\u5fd7\uff0c\u4e0d\u6539\u5224\u65ad\u903b\u8f91\uff09\uff0c\u53ef\u4ee5\u5417\uff1f)$/;
  // The configuration noun is data, but it must not carry an action clause either.
  if (/(?:\u5220\u9664|\u53d1\u9001|\u516c\u5f00|\u6388\u6743|\u4ed8\u8d39|\u8d2d\u4e70|\u767b\u5f55|\u51ed\u636e|\u5bc6\u94a5|\u4e0d\u53ef\u9006)/.test(question)) return false;
  const chineseReason = /^\u53d1\u5e03\u4ee3\u7801\u5ba1\u67e5$/;
  const ownsCode = new RegExp(owned, 'i').test(`${question} ${reason}`)
    || /^\u5728\u56e2\u961f\u81ea\u5df1\u7684\u4ed3\u5e93/.test(question);
  return ownsCode && (codeQuestion.test(question) || chineseQuestion.test(question))
    && (codeReason.test(reason) || chineseReason.test(reason));
}

/**
 * Correct an outward label only for a local preparation question. Use a closed action grammar:
 * an artifact may name a post or mail, but an extra action never inherits the draft's approval.
 * The reason may describe eventual publication; the ask and full details name this step.
 */
export function isLocalDraftAsk(ask: string | undefined, more?: string): boolean {
  const question = str(ask).replace(/\uff1f$/, '?');
  if (!question) return false;
  const artifact = '(?:CR|PR|change request|code review|pull request|(?:blog )?post|email|mail|(?:Slack )?message|reply|announcement|patch|code|change|release notes|fix)';
  const topic = '(?:the )?(?:(?:auth|logging|flaky|deploy|merge|submit) )?(?:fix|test|script|conflict|button|outage)';
  const scope = `(?: to (?:the )?(?:customer|vendor|team))?(?: in another team's package)?(?: (?:for|about) ${topic})?`;
  const local = '(?:locally|for review|locally for review)';
  const hold = '(?:(?:keep|hold|save) (?:it|the draft) (?:local(?:ly)?(?: and unpublished)?(?: for (?:now|review))?|unpublished(?: until you review it)?|for review))';
  const noSend = "(?:(?:do not|don't|never) (?:send|publish|submit|post) it|without (?:publishing it|sending it(?: or posting it)?))";
  const clause = `(?:${hold}|${noSend})`;
  const suffix = `(?:[,;]? (?:and |but )?${clause})*`;
  const draft = new RegExp(`^(?:Can I |Should I |May I )?Draft (?:a |an |the )?${artifact}${scope}(?: (?:draft|${local}))?${suffix}\\?$`, 'i');
  const prepare = new RegExp(`^(?:Can I |Should I |May I )?(?:Prepare|Write|Compose) (?:a |an |the )?${artifact}${scope}(?: draft)? ${local}${suffix}\\?$`, 'i');
  // Each Chinese clause names either preparation, a local list edit, or holding/not sending it.
  // No catch-all clause: a recipient action, deferred send or positive/negative question stays gated.
  const first = /^(?:(?:\u8981|\u9700\u8981|\u53ef\u4ee5)?\u6211)?(?:\u8d77\u8349|\u8349\u62df|\u51c6\u5907)\s*(?:\u4e00(?:\u884c\u6539\u52a8|\u5c01\u90ae\u4ef6|\u4efd\u5e16\u5b50|\u6761\u6d88\u606f|\u4e2a CR)|CR ?\u8349\u7a3f|\u90ae\u4ef6|\u5e16\u5b50|\u516c\u544a|\u8865\u4e01|\u8349\u7a3f)(?:\u5417)?$|^(?:\u5728)?\u672c\u5730\u5199(?:\u4e00\u4efd\u5e16\u5b50|\u4e00\u5c01\u90ae\u4ef6|\u4e00\u6761\u6d88\u606f)$/i;
  const rest = /^(?:\u628a\u65b0\u8d26\u53f7\u52a0\u8fdb [a-zA-Z ]{1,40} \u5171\u4eab\u540d\u5355|\u5148\u5b58(?:\u672c\u5730|\u8349\u7a3f)(?:\u7b49\u4f60\u5ba1)?|\u4fdd\u7559\u7b49\u4f60\u5ba1|\u7b49\u4f60\u5ba1|(?:\u5148\u4e0d|\u6682\u4e0d|\u4e0d)(?:\u53d1\u9001|\u53d1\u5e03|\u63d0\u4ea4|\u53d1\u7ed9\u5ba2\u6237))(?:\u5417)?$/;
  const chinese = question.replace(/[\uff1f?]$/, '').split(/[\uff0c,\uff1b;]/);
  const localQuestion = draft.test(question) || prepare.test(question)
    || (first.test(chinese[0] ?? '') && chinese.slice(1).every((part) => rest.test(part)));
  if (!localQuestion) return false;
  const explicitHold = /\b(?:local(?:ly)?|unpublished)\b|\b(?:do not|don't|never) (?:submit|publish|send)\b/i.test(question);
  if (/in another team's package/i.test(question) && !explicitHold) return false;
  const sharing = /\u5171\u4eab\u540d\u5355/.test(question);
  if (sharing && (!/\u8d77\u8349\u4e00\u884c\u6539\u52a8/.test(question) || !/\u5148\u5b58(?:\u672c\u5730|\u8349\u7a3f)|\u4fdd\u7559\u7b49\u4f60\u5ba1|\u7b49\u4f60\u5ba1/.test(question))) return false;
  // Only known local-only detail sentences extend the exception. Unrecognized details retain
  // approval rather than letting a short safe summary conceal another action.
  const detail = str(more);
  return !detail || /^(?:Keep (?:this|the) draft local and unpublished for now\.|Keep the draft local; do not publish it\.)$/i.test(detail);
}

export type UserKindVerdict =
  | { ok: true; kind: UserKind; why: string }
  | { ok: false; message: string };

function str(v: unknown): string { return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : ''; }

/**
 * A reason that says the user already agreed to it, with nothing new named (2026-11-20, the user:
 * "why the fuck is this need you, shoudl be done right , nothing need from me"): a task whose CRs he
 * had agreed to publish sat in Needs you asking whether to swap in their new descriptions. A step
 * that finishes what they agreed to is the task's own (team-charter.ts, answered-there.ts). A reason
 * that names what is new in the step (a new step, another recipient, one beyond or outside what they
 * agreed to) still reaches them. "New descriptions" alone is not that: it was the follow-up of 11-20. Pure; exported for tests.
 */
export function followsAgreedStep(why: string): boolean {
  // Only the user's own yes counts ("Alex already agreed to move the meeting" is someone else's).
  const agreed = /\b(?:he|she|you|the user) (?:has |had )?(?:already |previously |earlier )?(?:agreed|approved|said (?:yes|ok(?:ay)?)|ok(?:ay)?(?:'?e)?d|signed off|gave (?:the |his |her |a )?(?:go-ahead|yes|ok(?:ay)?|approval))\b|(?:\u4ed6|\u5979|\u4f60)(?:\u5df2(?:\u7ecf)?|\u65e9\u5c31|\u4e4b\u524d)?(?:\u540c\u610f|\u6279\u51c6|\u70b9\u5934|\u7b54\u5e94|\u62cd\u677f)(?:\u8fc7|\u4e86)|(?:\u4ed6|\u5979|\u4f60)(?:\u5df2(?:\u7ecf)?|\u65e9\u5c31)(?:\u540c\u610f|\u6279\u51c6|\u70b9\u5934|\u7b54\u5e94|\u62cd\u677f)/i;
  if (!agreed.test(why)) return false;
  // A step of another of his kinds (a code only he has, money, a delete, his name) is still his.
  const newStep = /\b(?:a new (?:step|action)|new (?:public|outward)|another (?:step|team|person|recipient|channel)|beyond|outside (?:what|the)|not covered|did not cover|didn't cover|never agreed|not agreed|never approved|not approved|extra|one-time code|code|password|passkey|sign(?:s|ing)? in|log(?:s|ging)? in|pay(?:s|ing|ment)?|charge|spend(?:s|ing)?|delet(?:e|es|ing)|in (?:his|her|their|the user's) name)\b|\$\s?\d|\u65b0\u7684\u4e00\u6b65|\u53e6\u4e00|\u8d85\u51fa|\u4e0d\u5728.{0,8}\u8303\u56f4|\u6ca1(?:\u6709)?\u540c\u610f|\u9a8c\u8bc1\u7801|\u5bc6\u7801|\u767b\u5f55|\u4ed8\u6b3e|\u82b1\u94b1|\u5220\u9664|\u4ee5\u4ed6\u7684\u540d\u4e49/i;
  return !newStep.test(why);
}

/**
 * A reason that rests on words the user said earlier ("you said the CR descriptions go to you
 * first"). 2026-11-20: a task asked him about the descriptions of its CRs on such a reason, and
 * his words had been about one other CR, in another task. Asking only ("he asked to pick a date")
 * is not a citation. Pure; exported for tests.
 */
export function citesUserWords(why: string): boolean {
  return /\b(?:you|he|she|the user) (?:said|told (?:me|us)|required|insisted)\b|\b(?:you|he|she|the user) asked (?:me |us )?to (?:see|show|send|review|check|run)\b.*\b(?:first|before)\b|\bper (?:his|her|your|the user's) (?:words|rule|instruction|ask|request)\b|\b(?:his|her|your|the user's) (?:own )?(?:words|rule|instruction)\b|(?:\u4f60|\u4ed6|\u5979)\u8bf4\u8fc7|(?:\u4f60|\u4ed6|\u5979)\u8bf4(?:\u4e86)?(?:\u8981|\u5148|\u4e0d\u8981)|(?:\u4f60|\u4ed6|\u5979)(?:\u8981\u6c42|\u4ea4\u4ee3)\u8fc7|\u539f\u8bdd|\u6309(?:\u4f60|\u4ed6|\u5979)\u7684\u8bdd/i.test(why);
}

/** The ids and links in a text that name one thing (a CR, a task, a ticket, a post), lower case. */
function thingIdsOf(text: string): string[] {
  const ids = text.match(/https?:\/\/\S+|\b[a-z]{1,8}-\d{3,}\b|\b[a-z0-9]{8}-[a-z0-9]{4}(?:-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{12})?\b|\b\d{6,}\b/gi) ?? [];
  return ids.map((id) => id.toLowerCase().replace(/[).,;\]]+$/, ''));
}

/**
 * Whether the words were about this ask: every id or link `about` names appears in the ask's own
 * title or question (never the reason or older context, where a sender names its source). Pure.
 */
function wordsAboutThisAsk(about: string, subject: string): boolean {
  const here = subject.toLowerCase();
  const ids = thingIdsOf(about);
  // With no id to compare, Walnut cannot tell: it passes, and the charter rule holds the rest.
  return !ids.length || ids.every((id) => here.includes(id));
}

/** The cited-words half of the check, for userKindVerdict. Null when it passes. */
function citedWordsRefusal(why: string, input: UserKindInput): string | null {
  // Only a caller that knows the ask's text checks it (the turn-end line has no room for the words).
  if (input.subject === undefined || !citesUserWords(why)) return null;
  const words = str(input.userKindWords ?? input.user_kind_words);
  const about = str(input.userKindAbout ?? input.user_kind_about);
  if (!words || !about) {
    return 'Not sent to the user: user_kind_why rests on words the user said earlier. Pass them with user_kind_words '
      + '(their words, verbatim) and user_kind_about (the task, CR, ticket or post those words were about), so Walnut can '
      + 'check they were about this ask. Words of theirs cover only what they were about.';
  }
  if (wordsAboutThisAsk(about, str(input.subject))) return null;
  return `Not sent to the user: the words you cite were about ${about}, and the question itself does not name it, so it reads as `
    + 'about something else. Those words cover only what they were about; never make them a rule for anything else. Decide this '
    + 'yourself, and a step that follows from what they already agreed to is yours: do it, then tell them in one line. If the '
    + `question really is about ${about}, name it in the question.`;
}

export interface UserKindInput {
  userKind?: unknown; user_kind?: unknown; userKindWhy?: unknown; user_kind_why?: unknown;
  /** The user's own earlier words the reason rests on, verbatim, and what they were about. */
  userKindWords?: unknown; user_kind_words?: unknown; userKindAbout?: unknown; user_kind_about?: unknown;
  /** The text of this ask (its title and question), to check cited words against. Never read from the caller's JSON. */
  subject?: string;
  /** The rest the user reads beside it (a body, More), where a picture may be (ask-clarity.ts). */
  detail?: string;
  /** The labels of its choices (ask-clarity.ts). */
  labels?: readonly string[];
  /** With a design or picture: who reviewed it, what they checked, what changed (ask-clarity.ts). */
  design_review?: unknown; designReview?: unknown;
}

/** `user_kind` + `user_kind_why`, either spelling of the keys, judged. Pure. */
export function userKindVerdict(input: UserKindInput): UserKindVerdict {
  const kind = str(input.userKind ?? input.user_kind);
  const why = str(input.userKindWhy ?? input.user_kind_why);
  const known = (USER_KINDS as readonly string[]).includes(kind);
  // Only explicit ops (a subject passed); the turn-end line keeps the old verdict, a refusal there
  // would silently turn the ask into a report to the lead.
  if (known && why.length >= USER_KIND_WHY_MIN && input.subject !== undefined && followsAgreedStep(why)) {
    return {
      ok: false,
      message: 'Not sent to the user: user_kind_why says they already agreed to this, so the step that follows is yours. '
        + 'Do it now and tell them in one line afterwards (a new description or picture for the same change, carrying out their words). '
        + 'Only if this step goes beyond what they agreed to, name what is new in it in user_kind_why.',
    };
  }
  const cited = known && why.length >= USER_KIND_WHY_MIN ? citedWordsRefusal(why, input) : null;
  if (cited) return { ok: false, message: cited };
  // An explicit call's question must read on its own (ask-clarity.ts).
  const unclear = known && why.length >= USER_KIND_WHY_MIN && input.subject !== undefined
    ? askClarityRefusal(input.subject, input.detail ?? '', input.labels ?? [], str(input.design_review ?? input.designReview)) : null;
  if (unclear) return { ok: false, message: unclear };
  if (known && why.length >= USER_KIND_WHY_MIN) return { ok: true, kind: kind as UserKind, why };
  const kinds = USER_KINDS.map((k) => `${k} (${USER_KIND_WORDS[k]})`).join('; ');
  return {
    ok: false,
    message: `Not sent to the user: a question reaches the user only when it is theirs. Name which kind it is with user_kind (one of: ${kinds}) `
      + `and user_kind_why (at least ${USER_KIND_WHY_MIN} characters, one line: what in THIS question makes it that kind). `
      + `${known ? 'user_kind_why is missing or too short. ' : kind ? `"${kind}" is not a kind. ` : ''}`
      + `${NOT_THE_USERS_DECISION} If none of the kinds fits, it is yours to decide. Do not reword it as a report or another thread state to get around this.`,
  };
}

/**
 * A turn-end self-report line "FOR_USER_ASK_OWN: <kind>: <why>" as the verdict. The kind word is
 * English whatever language the why is written in; a dash or a full-width colon after it is read too.
 */
export function userKindFromLine(line: string | undefined): UserKindVerdict {
  const m = /^\s*([a-z_]+)\s*(?:[:\uff1a]|\s-\s)\s*(.+)$/i.exec(line ?? '');
  return userKindVerdict({ user_kind: m?.[1]?.toLowerCase(), user_kind_why: m?.[2] });
}

/** The line that leads a letter the user reads, so they see why it is theirs, in the letter language. */
export function userKindLead(v: Extract<UserKindVerdict, { ok: true }>, lang: LetterLang = 'en'): string {
  return USER_KIND_LEAD_WORDS[lang](v.kind, v.why);
}

/** The op parameters' help (human_inbox_send, thread_update, thread_create). */
export const USER_KIND_PARAM =
  'Required when you hand the user a question (an action_required letter, a thread moved to needs or opened waiting on them): '
  + 'which of the user\'s own kinds it is. ' + Object.entries(USER_KIND_WORDS).map(([k, w]) => `${k}: ${w}`).join('; ') + '. '
  + 'Anything else is yours to decide.';
export const USER_KIND_WORDS_PARAM =
  'With user_kind, when user_kind_why rests on words the user said earlier: those words, verbatim. Words of theirs cover only what they were about.';
export const USER_KIND_ABOUT_PARAM =
  'With user_kind_words: the task, CR, ticket or post those words were about (its id or link). Refused when it is not what this ask is about.';
export const DESIGN_REVIEW_PARAM =
  'With a needs that shows a design, image or page: the reviewer subagent\'s model (another model than its maker: Sol, where your Agent tool has it), '
  + 'its scores for function, experience and interface out of 10, and what changed ("sol: function 8/10, experience 7/10, '
  + 'interface 6/10; fixed ..."); "small: <what changed>" for a text-only or colour-only change.';
export const USER_KIND_WHY_PARAM =
  `With user_kind: one line (at least ${USER_KIND_WHY_MIN} characters), in the language you write to the user, saying what in THIS question makes it that kind. The user reads it first. ${NOT_THE_USERS_DECISION}`;
