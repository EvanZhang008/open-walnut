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
  outward: 'a message or post that leaves Walnut (mail, chat, a public push, a publish)',
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
  + 'your team (or the user, in a line afterwards) what you chose.';

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
  `With user_kind: one line (at least ${USER_KIND_WHY_MIN} characters) saying what in THIS question makes it that kind. The user reads it first. ${NOT_THE_USERS_DECISION}`;
