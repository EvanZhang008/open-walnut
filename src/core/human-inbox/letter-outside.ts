/**
 * Which letters carry outside text, so an agent reading the inbox (human_inbox_list, _get) gets their
 * words inside the one frame for outside text (core/outside-content.ts) and the rest plain.
 *
 * A letter is outside when its words may be a stranger's: a plugin wrote it (the mail digest, a mail
 * approval or unsubscribe letter, any third-party plugin), the mail router's "For you" letter quotes a
 * mail's sender and subject, an Inbox Triage run summarizes outside mail, a script with no session
 * wrote it, or one of Walnut's own templates quotes outside text. A task's own letter
 * (human_inbox_send) and Walnut's own notices stay plain: their words are an agent's or Walnut's.
 *
 * Every member is classified in one table below, and tests/core/human-inbox/letter-outside.test.ts
 * fails when a new origin kind, a new Walnut letter kind or a new exempt send site appears unclassified.
 * Email items (`items`) are a mail's display data by their schema (item-schema.ts): always outside,
 * whoever sent the letter.
 *
 * Pure: reads the letter as the store or the route gives it (`createdByOp`, `sender`, `origin`).
 */
import { letterOriginOf, type LetterOriginKind } from './letter-origin.js';
import { routerLetterOpKey } from '../router/letter-receipts.js';
import type { LetterSender } from './types.js';

export interface WordsRule {
  /** The source an agent reads them under, or null: the sender's own words, read plain. */
  outside: string | null;
  why: string;
}

/** Per origin kind (letter-origin.ts LETTER_ORIGIN_KINDS): whose words its letters are. */
export const LETTER_ORIGIN_WORDS: Readonly<Record<LetterOriginKind, WordsRule>> = {
  task: { outside: null, why: 'a Walnut task\'s session wrote it (human_inbox_send): an agent\'s own words' },
  session: { outside: null, why: 'a session with no task wrote it: an agent\'s own words' },
  triage: { outside: 'inbox triage letter', why: 'an Inbox Triage run summarizes outside mail and quotes its senders and subjects' },
  walnut: { outside: null, why: 'Walnut\'s own template; a template that quotes outside text is named in WALNUT_LETTER_KIND_WORDS' },
  plugin: { outside: 'plugin letter', why: 'a plugin supplies every word, often what it read from outside (a mail, an event, a ticket)' },
  script: { outside: 'script letter', why: 'a caller of the letter route with no session: Walnut cannot say whose words these are' },
};

/** Every kind of walnut-letters/registry.ts, by id: whether its template quotes outside text. */
export const WALNUT_LETTER_KIND_WORDS: Readonly<Record<string, WordsRule>> = {
  'host-sign-in': { outside: null, why: 'Walnut\'s words, a host name and the SSH error line of the user\'s own machine' },
  'host-exec-ask': { outside: null, why: 'Walnut\'s words around a task title and the command an agent asked to run' },
  'budget-paused': { outside: null, why: 'Walnut\'s words around a task title and its spend' },
  'org-report': { outside: 'walnut report quoting letters', why: 'the morning report quotes the subjects of other letters, a plugin\'s among them' },
  'mail-approval': { outside: 'mail', why: 'a draft\'s subject and body, and the subject of the mail it answers' },
  'mail-unsubscribe': { outside: 'mail', why: 'a mailing list\'s sender, subject and unsubscribe address' },
  'mail-digest': { outside: 'mail', why: 'subjects, senders and summaries of new mail' },
  'mail-no-router': { outside: null, why: 'Walnut\'s words around the user\'s own mailbox address' },
  'offline-conflict': { outside: null, why: 'the user\'s own edits that met while a host was away' },
  'local-network-blocked': { outside: null, why: 'Walnut\'s words around a host name' },
  'ssh-cert-expiry': { outside: null, why: 'Walnut\'s words, a host name and the SSH error line of the user\'s own machine' },
};

/**
 * Every send site walnut-letters/registry.ts EXEMPT_LETTER_SENDS lets write words that are not
 * Walnut's own, and how a reader tells its letters apart.
 */
export const LETTER_SEND_WORDS: Readonly<Record<string, WordsRule>> = {
  'src/core/human-inbox/store.ts': { outside: null, why: 'the store itself; its callers are classified' },
  'src/core/router/service.ts': { outside: 'mail router letter', why: 'a "For you" letter quotes a mail\'s sender and subject; told by its createdByOp (router-letter:)' },
  'src/core/human-inbox/letter-ops.ts': { outside: null, why: 'a session\'s own letter; one with no session is origin script, framed' },
  'src/core/human-inbox/relay.ts': { outside: null, why: 'a session\'s letter relayed from a replica' },
  'src/web/routes/human-inbox-v1.ts': { outside: null, why: 'POST /human-inbox: a session\'s own letter; a caller with no session is origin script, framed' },
  'src/core/offline-merge/apply-letter.ts': { outside: null, why: 'journal replay of a session\'s letter written while the server was away' },
  'src/core/plugins/plugin-letters.ts': { outside: 'plugin letter', why: 'walnut.letters.send stamps sender.pluginId: framed by it' },
};

/** The `createdByOp` every router "For you" letter carries (router/letter-receipts.ts). */
export const ROUTER_LETTER_OP_PREFIX = `${routerLetterOpKey('', '').replace(/:+$/, '')}:`;

/** What a letter is read as here: the stored record or the route's row. */
export interface LetterWordsInput {
  sender?: Partial<LetterSender>;
  createdByOp?: string;
  origin?: { kind?: string };
}

/** The source a letter's words are framed under for an agent, or undefined: its sender's own words. */
export function letterOutsideSource(letter: LetterWordsInput): string | undefined {
  const sender = letter.sender ?? {};
  // Checked before the origin: a plugin's letter built from a Walnut template reads origin `walnut`.
  if (sender.pluginId) return `plugin ${sender.pluginId}`;
  const op = typeof letter.createdByOp === 'string' ? letter.createdByOp : '';
  if (op.startsWith(ROUTER_LETTER_OP_PREFIX)) return LETTER_SEND_WORDS['src/core/router/service.ts']!.outside!;
  const kindId = op.includes(':') ? op.slice(0, op.indexOf(':')) : '';
  const kindRule = kindId ? WALNUT_LETTER_KIND_WORDS[kindId] : undefined;
  if (kindRule?.outside) return kindRule.outside;
  const given = letter.origin?.kind;
  const kind = (given && given in LETTER_ORIGIN_WORDS ? given : letterOriginOf({ sender: { sessionId: 'external', ...sender } as LetterSender }, !!kindRule).kind) as LetterOriginKind;
  return LETTER_ORIGIN_WORDS[kind]?.outside ?? undefined;
}

/**
 * The source a thread turn's words are framed under, or undefined. A person's turn is theirs; another
 * turn is outside when its letter is, or when a plugin or a script wrote that turn into any letter.
 */
export function turnOutsideSource(turn: { from?: unknown; sender?: Partial<LetterSender> }, letterSource: string | undefined): string | undefined {
  if (turn.from === 'human') return undefined;
  if (turn.sender?.pluginId) return `plugin ${turn.sender.pluginId}`;
  if (turn.sender?.via === 'api') return LETTER_ORIGIN_WORDS.script.outside ?? undefined;
  return letterSource;
}

/** Email items are a mail's display data (item-schema.ts): framed under this source in every letter. */
export const LETTER_ITEMS_SOURCE = 'mail';
