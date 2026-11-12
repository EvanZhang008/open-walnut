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
import type { LetterLang } from '../human-inbox/walnut-letters/languages.js';
import { USER_KIND_LEAD_WORDS } from '../human-inbox/walnut-letters/thread-words.js';

export const USER_KINDS = [
  'outward', 'spending', 'credentials', 'permissions', 'cloud_delete', 'irreversible', 'user_info', 'user_own',
] as const;
export type UserKind = (typeof USER_KINDS)[number];

/** What each kind means, in the words the refusal and the letter use. */
export const USER_KIND_WORDS: Readonly<Record<UserKind, string>> = {
  outward: 'a message or post to people, a public push or publish, or anything leaving the team\'s own code; not a code change, commit or change request in the team\'s own repo/package',
  spending: 'spending money or quota that is not already budgeted',
  credentials: 'a credential, key or sign-in',
  permissions: 'a permission, access or setting that widens what an agent may do',
  cloud_delete: 'deleting cloud resources or data',
  irreversible: 'a choice that is hard to reverse and no existing rule covers',
  user_info: 'a fact, preference or access only the user has and nothing readable shows',
  user_own: 'the user\'s own matter: their mail, calendar or people, or something they asked to decide or follow',
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

/** `user_kind` + `user_kind_why`, either spelling of the keys, judged. Pure. */
export function userKindVerdict(input: { userKind?: unknown; user_kind?: unknown; userKindWhy?: unknown; user_kind_why?: unknown }): UserKindVerdict {
  const kind = str(input.userKind ?? input.user_kind);
  const why = str(input.userKindWhy ?? input.user_kind_why);
  const known = (USER_KINDS as readonly string[]).includes(kind);
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
export const USER_KIND_WHY_PARAM =
  `With user_kind: one line (at least ${USER_KIND_WHY_MIN} characters), in the language you write to the user, saying what in THIS question makes it that kind. The user reads it first. ${NOT_THE_USERS_DECISION}`;
