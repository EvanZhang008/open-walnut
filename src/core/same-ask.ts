/**
 * One decision, asked once (2026-11-04, a VP's daily reflection: a lead and its subtask both
 * sat in Needs you asking the user whether to create three alpha test accounts, and Main had the VP
 * merge them by hand; the user, 11-01: "why need me").
 *
 * When a task and a task above or below it ask the user the same thing, the user sees it once, from
 * the task closest to the work (the deepest). Two halves:
 *  - the shown status (user-status-sync.ts statusOf): an ancestor whose own ask is the same as one
 *    its subtree carries up (rollUpAsks) reads Waiting on that subtask (`sameAsk` on its status), so
 *    every surface reading `user_status` (Home's Needs you rows, the Org Task view, a VP's or Main's
 *    rolled asks, the Brief, the phone) lists it once; answering the subtask settles both while the
 *    ancestor holds the same report, and its next status question says where the answer went;
 *  - the writes (same-ask-tree.ts): a report line, a decision letter or a Thread put on the user
 *    while a task in the same tree already holds the ask is refused (409 `same_ask`) with that ask
 *    and its task named; the turn-end status question lists the tree's open asks, so a session
 *    reads that its subtask already asked and says FOR_USER_ASK_SAME instead of asking again.
 *
 * Sameness is deterministic and cheap, and strict: the same content words in the same order (at
 * least three; askWords). A session's own word (FOR_USER_ASK_SAME: <id> | different) wins over the
 * text test and covers the same decision in other words; there is no model call. Only a session's
 * own question and a Board choice fold; the fold outlives the deeper ask only while that task still
 * holds it, or on evidence the user answered it there (a person's message to it after the fold).
 * Pure functions here; the tree reads are in same-ask-tree.ts.
 */
import { normalizeText } from './human-inbox/duplicate-letter.js';
import type { RolledAsk, StatusReport, UserStatus } from './user-status.js';

/** A deliberate second ask says why in at least this many characters. */
export const SAME_ASK_REASON_MIN = 10;

/**
 * Needs sources an ask can be folded from: a session's own question and a Board choice. Not a live
 * prompt or a failed session (the task's own state), not a person's own mark (no source: the user
 * set it, and two marks share one fixed sentence), and not a decision letter (the inbox is where the
 * user answers it; a later letter of the tree asking the same is refused instead).
 */
export const FOLDABLE_SOURCES: ReadonlySet<NonNullable<UserStatus['source']>> = new Set(['session', 'choice']);

/** Words that frame a question without naming what it is about (Latin), and CJK framing phrases. */
const FRAME_WORDS = new Set([
  'a', 'an', 'the', 'to', 'of', 'for', 'on', 'in', 'at', 'by', 'and', 'or', 'with', 'from', 'this', 'that', 'these', 'those', 'it', 'its',
  'we', 'i', 'you', 'your', 'our', 'my', 'me', 'us', 'please', 'should', 'shall', 'can', 'could', 'would', 'will', 'do', 'does', 'did',
  'is', 'are', 'be', 'go', 'ahead', 'ok', 'okay', 'whether', 'if', 'now', 'yes', 'let', 'lets', 'want', 'need',
]);
const CJK_FRAMES = /\u8981\u4e0d\u8981|\u662f\u4e0d\u662f|\u662f\u5426|\u80fd\u4e0d\u80fd|\u53ef\u4e0d\u53ef\u4ee5|\u53ef\u4ee5\u5417|\u884c\u4e0d\u884c|\u597d\u4e0d\u597d|\u9700\u4e0d\u9700\u8981|\u8bf7\u4f60|\u8bf7|\u5417|\u5462|\u5427|\u6211\u4eec|\u6211|\u4f60\u4eec|\u4f60|\u4e00\u4e0b|\u5e2e\u5fd9|\u9ebb\u70e6/gu;
const CJK_PIECE = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/** One English word to its plain form: "accounts" and "account" are one word. */
function stem(w: string): string {
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 3 && w.endsWith('es') && /(ss|sh|ch|x)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

/** A text-only match needs at least this many content words (or CJK character pairs): "Merge it?" is no evidence. */
export const SAME_ASK_MIN_WORDS = 3;

/**
 * What an ask is about, in order: its content words (framing words left out, "no" and "not" kept),
 * its numbers, and every pair of adjacent characters of its CJK text (framing phrases left out).
 * Two asks are one only when these are the same sequence, so "delete the staging database" and
 * "delete the production database", or "from staging to production" and "from production to
 * staging", never are.
 */
export function askWords(text: string | undefined | null): string[] {
  const norm = normalizeText(text ?? '').replace(CJK_FRAMES, ' ');
  const out: string[] = [];
  for (const piece of norm.split(/(\p{Script=Han}+|\p{Script=Hiragana}+|\p{Script=Katakana}+|\p{Script=Hangul}+)/u)) {
    if (!piece) continue;
    if (CJK_PIECE.test(piece)) {
      const chars = [...piece];
      if (chars.length === 1) out.push(chars[0]!);
      for (let i = 0; i + 1 < chars.length; i++) out.push(chars[i]! + chars[i + 1]!);
      continue;
    }
    for (const w of piece.split(/[^\p{L}\p{N}]+/u)) {
      if (!w || FRAME_WORDS.has(w)) continue;
      out.push(/^\d+$/.test(w) ? w : stem(w));
    }
  }
  return out;
}

/** The key a fold remembers its ask by: its content words, in order. */
export function askKey(text: string | undefined | null): string {
  return askWords(text).join(' ');
}

/**
 * Whether two asks ask the user the same thing, by their words alone: the same content words in the
 * same order, at least SAME_ASK_MIN_WORDS of them. Deliberately strict (2026-11-04 review: a looser
 * similarity folded "staging" under "production"): a fold hides an ask, a miss only shows it twice,
 * and the sessions' own word (FOR_USER_ASK_SAME) covers the same decision in other words.
 */
export function sameAskText(a: string | undefined | null, b: string | undefined | null): boolean {
  const wa = askWords(a);
  return wa.length >= SAME_ASK_MIN_WORDS && wa.join(' ') === askWords(b).join(' ');
}

/** The fold an ancestor's status carries: whose ask it is shown as, and what it remembers. */
export interface SameAskFold {
  /** The task that asks it (the deepest owner). */
  id: string;
  title: string;
  /** Its ask, as the user reads it there. */
  ask: string;
  /** This task's own ask, folded (askKey), and the report it came from. */
  key: string;
  stamp: string;
  /** When it was first folded (ISO): a person's message to the deeper task after this is the answer. */
  at: string;
  /** The user wrote to the deeper task after the fold, and it asks no more: the answer went there. */
  answered?: true;
}

/** What a fold reads of the tasks around it. */
export interface FoldContext {
  /** This task's current report (its stamp, and its own word on sameness). */
  report?: Pick<StatusReport, 'at' | 'same_as' | 'ask_distinct'> | null;
  /** The status it holds now (a fold it made before). */
  prev?: UserStatus | null;
  /** The asking task's own word, from its current report while its ask is that report's (same_as,
   *  ask_distinct); null otherwise. */
  declared?: (taskId: string) => Pick<StatusReport, 'same_as' | 'ask_distinct'> | null | undefined;
  /** When a person last wrote to that task's sessions (ISO): the evidence an answer went there. */
  personInputAt?: (taskId: string) => string | null | undefined;
  /** Whether that task still holds this ask while it is not shown (its turn runs on it, its report
   *  is on the way, or it is snoozed with it): the fold stays as it is. */
  stillAsks?: (taskId: string, ask: string) => boolean;
  /** Now (ISO), for a new fold's `at`. */
  nowIso?: string;
}

/** The report a fold is tied to: the ask's own report, else the source and the words. */
function stampOf(status: UserStatus, report: FoldContext['report']): string {
  return status.source === 'session' && report?.at ? `report:${report.at}` : `${status.source ?? 'none'}:${askKey(status.ask)}`;
}

export function foldWords(f: Pick<SameAskFold, 'title' | 'ask' | 'answered'>): string {
  const title = f.title.replace(/\s+/g, ' ').slice(0, 80);
  return f.answered
    ? `Its subtask "${title}" asked you the same, and you answered it there`
    : `Its subtask "${title}" asks you the same: ${f.ask.replace(/\s+/g, ' ').slice(0, 160)}`;
}

/**
 * The status the user is shown for a task whose own ask its subtree already asks: Waiting on the
 * deepest task that asks it, its own words kept. Any other status as derived, a stale fold dropped.
 * `asks` are the questions its subtree carries up (rollUpAsks), nearest first. Pure.
 *
 * Once the deeper task asks no more, the fold stays only on evidence that the user answered it
 * there (a message from a person to it after the fold) and only while this task holds the same
 * report; anything else (the subtask moved away, snoozed, asks something else) brings this task's
 * own ask back, so an ask is never hidden on a guess.
 */
export function foldSameAsk(selfId: string, derived: UserStatus, asks: readonly RolledAsk[], ctx: FoldContext = {}): UserStatus {
  if (derived.state !== 'needs' || !derived.ask || !derived.source || !FOLDABLE_SOURCES.has(derived.source)) return derived;
  const own = ctx.report ?? null;
  const key = askKey(derived.ask);
  const stamp = stampOf(derived, own);
  const prev = ctx.prev?.sameAsk;
  const pick = (): RolledAsk | undefined => {
    // Its own word first; a "different" from either side is never folded.
    if (own?.ask_distinct) return undefined;
    const named = own?.same_as ? asks.find((a) => a.id === own.same_as) : undefined;
    if (named) return named;
    return asks.find((a) => {
      const theirs = ctx.declared?.(a.id);
      if (theirs?.ask_distinct) return false;
      return theirs?.same_as === selfId || sameAskText(derived.ask, a.ask);
    });
  };
  const hit = pick();
  let fold: SameAskFold | null = null;
  if (hit) {
    const at = prev && prev.id === hit.id && prev.key === key && prev.at ? prev.at : (ctx.nowIso ?? new Date().toISOString());
    fold = { id: hit.id, title: hit.title, ask: hit.ask, key, stamp, at };
  } else if (prev && prev.key === key && prev.stamp === stamp && prev.at && !prev.answered && ctx.stillAsks?.(prev.id, prev.ask)) {
    fold = prev;
  } else if (prev && prev.key === key && prev.stamp === stamp && prev.at) {
    const wrote = Date.parse(ctx.personInputAt?.(prev.id) ?? '');
    if (prev.answered || (Number.isFinite(wrote) && wrote >= Date.parse(prev.at))) fold = { ...prev, answered: true };
  }
  if (!fold) return derived;
  const out: UserStatus = {
    state: 'waiting', kind: 'task', waitingOn: foldWords(fold), sameAsk: fold,
    ...(derived.now ? { now: derived.now } : {}),
    ...(derived.next ? { next: derived.next } : {}),
    ...(derived.at ? { at: derived.at } : {}),
    ...(derived.stale ? { stale: derived.stale } : {}),
    ...(derived.due ? { due: derived.due } : {}),
    ...(derived.asks ? { asks: derived.asks } : {}),
  };
  return out;
}

/** An open ask in a task's tree, as a write is checked against it (same-ask-tree.ts). */
export interface TreeAsk {
  taskId: string;
  title: string;
  ask: string;
  /** Where it lives: the task's status (its own question, a Board choice), or an open decision letter. */
  where: 'status' | 'letter';
  letterId?: string;
  /** Where that task stands to the writer's task. */
  relation: 'ancestor' | 'descendant' | 'team';
}

/** The first open ask in the tree that asks what `text` asks, or null. */
export function findSameAsk(text: string, asks: readonly TreeAsk[]): TreeAsk | null {
  return asks.find((a) => sameAskText(text, a.ask)) ?? null;
}

/** The reason given for asking again anyway (one line), or ''. */
export function sameAskReasonOf(input: { same_ask_reason?: unknown; sameAskReason?: unknown } | null | undefined): string {
  const raw = input?.same_ask_reason ?? input?.sameAskReason;
  const reason = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
  return reason.length >= SAME_ASK_REASON_MIN ? reason : '';
}

const RELATION_WORDS: Record<TreeAsk['relation'], string> = {
  ancestor: 'a task above this one', descendant: 'a subtask of this one', team: 'a task in this team',
};

/** The refusal's words: which ask, where, and what to do instead. */
export function sameAskMessage(hit: TreeAsk, what: 'letter' | 'report' | 'thread'): string {
  const where = hit.where === 'letter' ? `in its open decision letter ${hit.letterId}` : 'in its status (Needs you)';
  const verb = what === 'letter' ? 'Not sent' : what === 'thread' ? 'Not handed to the user' : 'Not put on the user';
  const instead = what === 'thread'
    ? 'Keep this thread working or pending and name that task in it (tasks); its answer reaches you through that task.'
    : 'Do not ask it again: the user answers it there, and that task carries the answer (task_send it if you need the answer too).';
  return `${verb}: ${RELATION_WORDS[hit.relation]}, "${hit.title.replace(/\s+/g, ' ').slice(0, 100)}" (${hit.taskId}), already asks the user this ${where}: "${hit.ask.replace(/\s+/g, ' ').slice(0, 200)}". `
    + `The user sees one decision once. ${instead} If it really is a different decision, write it so, or pass same_ask_reason: one line (at least ${SAME_ASK_REASON_MIN} characters) saying why it is not the same.`;
}

export class SameAskError extends Error {
  readonly code = 'same_ask';
  readonly status = 409;
  constructor(message: string, readonly hit: TreeAsk) {
    super(message);
    this.name = 'SameAskError';
  }
}
