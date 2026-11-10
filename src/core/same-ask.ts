/**
 * One decision, asked once (2026-11-04, a VP's daily reflection: a lead and its subtask both
 * sat in Needs you asking the user whether to create three alpha test accounts, and Main had the VP
 * merge them by hand; the user, 11-01: "why need me").
 *
 * When two tasks of one team ask the user the same thing, the user sees it once. A task and a task
 * above or below it: from the task closest to the work (the deepest). Two tasks side by side under
 * one lead or VP (siblings, cousins; 2026-11-04, a VP's reflection again: a lead and the review task
 * beside it asked the same design decision with opposite picks): from the one that asked first. Two
 * halves:
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

/**
 * Whether two asks of ONE task ask the user the same thing in other words (2026-11-04: three VPs
 * each told the user "nothing changed, only reworded" when a task's session rewrote its ask). Looser
 * than sameAskText on purpose, and only for one task's ask over time (askShape, sameAskShape): added
 * detail, a reordered clause or a synonym is the same ask; a new decision with new words, other
 * numbers, a "not" one has and the other lacks, two words swapped around ("from staging to
 * production"), another word after "from" or "to", or one or two words replaced and nothing else
 * changed ("the staging account database" for "the production customer database") is not. An ask of fewer than SAME_ASK_MIN_WORDS content words is the same only word
 * for word.
 */
export function sameAskReworded(a: string | undefined | null, b: string | undefined | null): boolean {
  return sameAskShape(askShape(a), askShape(b));
}

/**
 * What sameAskShape compares: the ask's content words in order, once each (`#3` for a number),
 * whether it says no, and where it points (`links`: a direction word with the word after it,
 * "from>staging", "to>production"; absent on a shape stored without them).
 */
export interface AskShape { words: string[]; neg: boolean; links?: string[] }

/** Words that say where an ask points ("from X to Y", "into Y", "instead of Y"); CJK ones become their English twin. */
const DIRECTIONS = new Set(['from', 'to', 'into', 'onto', 'toward', 'towards', 'than', 'instead', 'versus', 'vs']);
const CJK_DIRECTIONS: Array<[RegExp, string]> = [
  [/\u4ece/gu, ' from '], [/\u5230|\u81f3/gu, ' to '], [/\u5411/gu, ' toward '],
  [/\u6539\u6210|\u6362\u6210|\u6539\u4e3a|\u53d8\u6210/gu, ' into '], [/\u800c\u4e0d\u662f|\u4ee3\u66ff/gu, ' instead '],
];

/** Content words of a direction target kept per link ("from the old staging database": old, staging, database). */
const LINK_WORDS_MAX = 4;

/**
 * The direction links of an ask (AskShape.links): each direction word with the content words after
 * it, up to the next direction word or the end of the clause, each through `token` and joined by
 * `+` ("from>old+staging+database").
 */
function directionLinks(text: string | undefined | null, token: (w: string) => string): string[] {
  let norm = normalizeText(nameDirections(text ?? ''));
  for (const [re, en] of CJK_DIRECTIONS) norm = norm.replace(re, en);
  const out = new Set<string>();
  for (const clause of norm.split(/[,.;:!?\u3001\uff0c\u3002\uff1b\uff1a\uff01\uff1f]+/u)) {
    const words = clause.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    for (let i = 0; i < words.length; i++) {
      if (!DIRECTIONS.has(words[i]!)) continue;
      const target: string[] = [];
      for (const w of words.slice(i + 1)) {
        if (DIRECTIONS.has(w) || target.length >= LINK_WORDS_MAX) break;
        if (FRAME_WORDS.has(w)) continue;
        // A CJK run is one "word" here: its first two characters stand for it, as askWords' bigrams do.
        target.push(CJK_PIECE.test(w) ? token([...w].slice(0, 2).join('')) : /^\d+$/.test(w) ? numberMarked(w) : token(stem(w)));
      }
      if (target.length) out.add(`${words[i]}>${target.join('+')}`);
    }
  }
  return [...out].sort();
}

/**
 * A name with a direction word inside it ("A to Z", "Door to Door", "Peer to Peer") says where
 * nothing points: its direction word is dropped before the links are read. Only "A to Z" and a
 * capitalized word repeated, so "Staging to Production" and "from X to Y" keep their direction (2026-11-10:
 * a portal named "A to Z" made one ask reworded read as pointing elsewhere, and come back as news).
 */
function nameDirections(text: string): string {
  return text.replace(/\b([A-Z][a-z]*) (to|vs|versus|into|from) ([A-Z][a-z]*)\b/g, (whole, a: string, d: string, b: string) =>
    (a === b && a.length > 1) || (a === 'A' && d === 'to' && b === 'Z') ? `${a} ${b}` : whole);
}

/**
 * Whether two asks point the same way: for each direction word both use, every target of one has
 * a target of the other with the same words or a part of them ("from staging" and "from the
 * staging environment" agree; "from the old staging database" and "from the old production
 * database" do not).
 */
/** Whether every direction target of `part` agrees with one of `whole`'s for that direction word. */
function pointsWithin(part: readonly string[], whole: readonly string[]): boolean {
  const split = (l: string) => { const [dir = '', to = ''] = l.split('>'); return { dir, to: new Set(to.split('+').filter(Boolean)) }; };
  const within = (x: Set<string>, y: Set<string>) => [...x].every((v) => y.has(v));
  const ws = whole.map(split);
  return part.map(split).every((p) => {
    const same = ws.filter((w) => w.dir === p.dir);
    return same.length === 0 || same.some((w) => within(p.to, w.to) || within(w.to, p.to));
  });
}

export function sameDirections(a: readonly string[], b: readonly string[]): boolean {
  const targets = (links: readonly string[]) => {
    const by = new Map<string, Array<Set<string>>>();
    for (const l of links) {
      const [dir = '', to = ''] = l.split('>');
      by.set(dir, [...(by.get(dir) ?? []), new Set(to.split('+').filter(Boolean))]);
    }
    return by;
  };
  const within = (x: Set<string>, y: Set<string>) => [...x].every((w) => y.has(w));
  const agree = (x: Set<string>, y: Set<string>) => within(x, y) || within(y, x);
  const ta = targets(a);
  const tb = targets(b);
  for (const [dir, xs] of ta) {
    const ys = tb.get(dir);
    if (!ys) continue;
    if (!xs.every((x) => ys.some((y) => agree(x, y))) || !ys.every((y) => xs.some((x) => agree(x, y)))) return false;
  }
  return true;
}

/** Latin and CJK words that turn an ask around ("do not", and the CJK words for "not" and "don't"). */
const NEGATIONS = new Set(['not', 'no', 'never', 'don', 'doesn', 'didn', 'won', 'cannot', 'nor']);
const CJK_NEGATION = /[\u4e0d\u522b\u52ff\u6ca1\u65e0\u672a]/u;

/** An ask's shape; `token` maps each content word (a brief mark keeps hashes, numbers as `#3`). */
export function askShape(text: string | undefined | null, token: (w: string) => string = (w) => w): AskShape {
  const raw = askWords(text);
  const neg = raw.some((w) => NEGATIONS.has(w) || CJK_NEGATION.test(w));
  const words = [...new Set(raw.filter((w) => !NEGATIONS.has(w)).map((w) => (/^\d+$/.test(w) ? numberMarked(w) : token(w))))];
  return { words, neg, links: directionLinks(text, token) };
}

/** A number as sameAskShape tells it apart (`#3`); any other word as given. */
export function numberMarked(w: string): string {
  return /^\d+$/.test(w) ? `#${w}` : w;
}

/** The rule of sameAskReworded on two shapes (numbers marked `#`). */
export function sameAskShape(a: AskShape, b: AskShape): boolean {
  if (a.neg !== b.neg) return false;
  if (a.words.length < SAME_ASK_MIN_WORDS || b.words.length < SAME_ASK_MIN_WORDS) return a.words.join(' ') === b.words.join(' ');
  const nums = (s: readonly string[]) => s.filter((w) => w.startsWith('#')).sort().join(' ');
  if (nums(a.words) !== nums(b.words)) return false;
  // Pointing elsewhere: a direction word both asks use, followed by another word ("from staging"
  // against "from production"), however long the rest of the ask is.
  if (a.links && b.links && !sameDirections(a.links, b.links)) return false;
  const inB = new Set(b.words);
  const shared = a.words.filter((w) => inB.has(w));
  const union = a.words.length + b.words.length - shared.length;
  if (shared.length / Math.min(a.words.length, b.words.length) < 0.5 || shared.length / union < 0.3) return false;
  // The shared words in another order: "staging to production" against "production to staging".
  const at = new Map(b.words.map((w, i) => [w, i] as const));
  let pairs = 0;
  let swapped = 0;
  for (let i = 0; i < shared.length; i++) {
    for (let j = i + 1; j < shared.length; j++) {
      pairs++;
      if (at.get(shared[i]!)! > at.get(shared[j]!)!) swapped++;
    }
  }
  if (pairs > 0 && swapped / pairs > 0.1) return false;
  // One or two words replaced and nothing else changed: another target ("the staging account
  // database" for "the production customer database"), not other words, however long the ask.
  const onlyA = a.words.length - shared.length;
  const onlyB = b.words.length - shared.length;
  if (onlyA >= 1 && onlyB >= 1 && Math.max(onlyA, onlyB) <= 2) return false;
  return true;
}

/** The fold an ancestor's status carries: whose ask it is shown as, and what it remembers. */
export interface SameAskFold {
  /** The task that asks it (the deepest owner, or the teammate that asked first). */
  id: string;
  /** That task is beside this one in its team (same-ask-tree.ts teamKeysOf), not below it. */
  team?: true;
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
  /** Both ask the user to sign in again (sign-in-ask.ts), whatever the words or the team. */
  signIn?: true;
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
  /** The open asks of its teammates beside it (never above or below it), each shown as Needs you
   *  now, the first asked first (same-ask-tree.ts relativesOf). */
  relatives?: readonly RelativeAsk[];
  /** When this task was made (ISO): two teammates that both show the ask keep the older one's. */
  selfCreatedAt?: string;
  /** When a lead, VP or Main answered that task's `ask` for the user (Task.ask_answered, ISO): like a
   *  person's message, the evidence the answer reached it. */
  answeredAt?: (taskId: string, ask: string) => string | null | undefined;
  /** That task's own status reads the ask answered (a fold of its own that was answered, or an answer
   *  above it): the answer travels along a chain of folds. */
  answeredThere?: (taskId: string) => boolean;
  /** When an answer to `ask` given there for the user was taken back (withdrawnAtOf): what it
   *  answered before then is no evidence any more. */
  withdrawnAt?: (taskId: string, ask: string) => string | null | undefined;
  /** Whether an ask asks the user to sign in again (sign-in-ask.ts isSignInAsk): two of them are one
   *  ask, and `relatives` then holds every task's sign-in ask, not only its teammates'. */
  signIn?: (ask: string) => boolean;
}

/** A teammate's open ask, as a fold reads it. */
export interface RelativeAsk extends RolledAsk {
  createdAt?: string;
  /** A lead, VP or Main already answered it there for the user (Task.ask_answered): a teammate
   *  asking the same reads it answered at once, never as a new Needs you. */
  answered?: true;
}

/** Of two teammates that both show the same ask, the one whose shows: the older task, then the lower id. */
function ranksFirst(a: { id: string; createdAt?: string }, b: { id: string; createdAt?: string }): boolean {
  // A task with no time recorded counts as the newest.
  const ta = a.createdAt || '\uffff';
  const tb = b.createdAt || '\uffff';
  return ta !== tb ? ta < tb : a.id < b.id;
}

/** The report a fold is tied to: the ask's own report, else the source and the words. */
function stampOf(status: UserStatus, report: FoldContext['report']): string {
  return status.source === 'session' && report?.at ? `report:${report.at}` : `${status.source ?? 'none'}:${askKey(status.ask)}`;
}

/** Its wait in words, as every surface prints it after "Waiting on": what it is first, since a row
 *  shows one line (2026-11-05 UI review: the title first left "same decision" cut off). */
export function foldWords(f: Pick<SameAskFold, 'title' | 'ask' | 'answered' | 'team' | 'signIn'>): string {
  const title = f.title.replace(/\s+/g, ' ').slice(0, 80);
  if (f.signIn) return f.answered ? `the user's sign-in, answered in "${title}"` : `the user's sign-in, asked once in "${title}"`;
  const where = f.team ? `"${title}", beside it in its team` : `its subtask "${title}"`;
  return f.answered
    ? `the same decision, answered in ${where}`
    : `the same decision in ${where}: ${f.ask.replace(/\s+/g, ' ').slice(0, 160)}`;
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
  const ownSignIn = !!ctx.signIn?.(derived.ask);
  const bothSignIn = (a: RolledAsk): boolean => ownSignIn && !!ctx.signIn?.(a.ask);
  const same = (a: RolledAsk): boolean => {
    // One sign-in is one ask, however each task words it (sign-in-ask.ts).
    if (bothSignIn(a)) return true;
    const theirs = ctx.declared?.(a.id);
    if (theirs?.ask_distinct) return false;
    return own?.same_as === a.id || theirs?.same_as === selfId || sameAskText(derived.ask, a.ask);
  };
  const pick = (): { hit: RolledAsk; team?: true } | undefined => {
    // Its own word first; a "different" from either side is never folded (a sign-in ask always is).
    if (own?.ask_distinct && !ownSignIn) return undefined;
    // Below it first: the deepest task shows it.
    const below = asks.find(same);
    if (below) return { hit: below };
    // Beside it: the older task keeps it (a fixed order, so two teammates never trade it as their
    // turns come and go), one answered there already takes it, and a fold made before stays where it
    // is (its holder still shows it: a teammate folded under another is never a holder).
    const self = { id: selfId, createdAt: ctx.selfCreatedAt };
    const beside = (ctx.relatives ?? []).find((r) => same(r) && (r.answered || prev?.id === r.id || ranksFirst(r, self)));
    return beside ? { hit: beside, team: true } : undefined;
  };
  const picked = pick();
  let fold: SameAskFold | null = null;
  if (picked) {
    const { hit } = picked;
    const at = prev && prev.id === hit.id && prev.key === key && prev.at ? prev.at : (ctx.nowIso ?? new Date().toISOString());
    fold = {
      id: hit.id, title: hit.title, ask: hit.ask, key, stamp, at,
      ...(picked.team ? { team: true as const } : {}), ...((hit as RelativeAsk).answered ? { answered: true as const } : {}),
      ...(bothSignIn(hit) ? { signIn: true as const } : {}),
    };
  } else {
    // An answer given there for the user that was taken back since the fold (sessions/ask-withdraw.ts):
    // only what reached that task after it counts (2026-11-09 review: a teammate read the withdrawn
    // answer as answered for good).
    const takenAt = prev?.at ? Date.parse(ctx.withdrawnAt?.(prev.id, prev.ask) ?? '') : NaN;
    const takenBack = Number.isFinite(takenAt) && takenAt >= Date.parse(prev!.at);
    if (prev && prev.key === key && prev.stamp === stamp && prev.at && (!prev.answered || takenBack) && ctx.stillAsks?.(prev.id, prev.ask)) {
      const { answered: _answered, ...open } = prev;
      fold = open;
    } else if (prev && prev.key === key && prev.stamp === stamp && prev.at) {
      // The answer reached that task: a person wrote to it, or a lead, VP or Main answered it there.
      const since = takenBack ? takenAt : Date.parse(prev.at);
      const reached = [ctx.personInputAt?.(prev.id), ctx.answeredAt?.(prev.id, prev.ask)].map((v) => Date.parse(v ?? '')).filter(Number.isFinite);
      if ((prev.answered && !takenBack) || ctx.answeredThere?.(prev.id) || reached.some((t) => t >= since)) fold = { ...prev, answered: true };
    }
  }
  if (!fold) return derived;
  const out: UserStatus = {
    state: 'waiting', kind: 'task', waitingOn: foldWords(fold), sameAsk: fold,
    ...(derived.now ? { now: derived.now } : {}),
    ...(derived.next ? { next: derived.next } : {}),
    ...(derived.now || derived.next ? reportSource(derived) : {}),
    ...(derived.at ? { at: derived.at } : {}),
    ...(derived.stale ? { stale: derived.stale } : {}),
    ...(derived.due ? { due: derived.due } : {}),
    ...(derived.asks ? { asks: derived.asks } : {}),
  };
  return out;
}

/**
 * A task's ask that a lead, a VP or Main answered for the user (2026-11-04, a VP's reflection: Main
 * had decided six questions for the user and written them into the lead's record, and the lead
 * still waited on him with them). Recorded on the asking task when one of them answers it with
 * `task_send answers_ask` (sessions/ask-answer.ts), whose message tells the asker once.
 */
export interface AskAnswer {
  /** The ask it answered (askKey) and its words. */
  key: string;
  ask: string;
  /** Its answer, cut to a line or two. */
  text: string;
  /** Who answered: a task id, or `human`, and the name the user reads. */
  by: string;
  byTitle: string;
  at: string;
  /** The user's own words it acts on, for an ask of a kind only they approve (APPROVAL_KINDS). */
  userWords?: string;
  /** Answering task's session, from the resolved caller; absent = a person or unknown. */
  sessionId?: string;
  /** The decision the ask carried when it was answered (ask-decision.ts): the same decision asked
   *  again in other words is still answered. Absent on an answer recorded before decisions had ids. */
  askId?: string;
  /** Its decision key then (id, revision, deadline, links): a new fact named since is asked again. */
  decisionKey?: string;
  /** The user withdrew the ask for good (task_send answers_ask with withdraw_ask, on their own words):
   *  it holds past ASK_ANSWER_HOLD_MS. Another decision still comes back, by the same rules. */
  withdrawn?: true;
}

/** The writer of a status's now/next, kept when a fold or an answer rebuilds it (user-status.ts reportSourceOf). */
function reportSource(s: Pick<UserStatus, 'reportBy' | 'reportSessionId'>): Pick<UserStatus, 'reportBy' | 'reportSessionId'> {
  return { ...(s.reportBy ? { reportBy: s.reportBy } : {}), ...(s.reportSessionId ? { reportSessionId: s.reportSessionId } : {}) };
}

/** An answer for the user that was taken back (sessions/ask-withdraw.ts), kept on the task as a record. */
export interface AskAnswerWithdrawal {
  key: string;
  ask: string;
  /** The answer that was taken back: its words, who gave it and when. */
  text: string;
  answeredBy: string;
  answeredByTitle: string;
  answeredAt: string;
  /** Who took it back: a task id, or `human`, and the name the user reads. */
  by: string;
  byTitle: string;
  at: string;
  reason?: string;
  /** Its report still asked it then, so it went back on the user's Needs you. */
  needsAgain: boolean;
  /** Told to a teammate whose same ask was folded under that task and read answered there. */
  via?: { id: string; title: string };
  /** How the task hears it: told, with its next message (session-message-queue.ts), or not at all (complete, no session). */
  told: 'now' | 'next_message' | 'not';
}

/** The withdrawals a task keeps (Task.asks_withdrawn), oldest first. */
export const ASKS_WITHDRAWN_MAX = 8;

/** When an answer to `ask` was last taken back on that task (Task.asks_withdrawn), or null. Pure. */
export function withdrawnAtOf(list: readonly AskAnswerWithdrawal[] | null | undefined, ask: string | null | undefined): string | null {
  if (!ask) return null;
  let best: string | null = null;
  for (const w of list ?? []) {
    if (w.via) continue;
    const same = w.key === askKey(ask) || sameAskReworded(w.ask, ask) || askIsPartOf(ask, w.ask);
    if (same && (!best || w.at > best)) best = w.at;
  }
  return best;
}

/** An answer above holds this long: a much later ask in the same words is a new decision. */
export const ASK_ANSWER_HOLD_MS = 7 * 24 * 60 * 60_000;

/** The answers a task keeps (Task.asks_answered); Task.ask_answered, the last one, for a record written before. */
export const ASKS_ANSWERED_MAX = 8;

/** What answerHolds knows of the ask now: its decision (ask-decision.ts) and when a person last wrote
 *  in the task (SessionRecord.humanInputAt), which lifts a withdrawal made before it. */
export interface AnswerDecision { id?: string; key?: string; said?: boolean; personAt?: string }

/**
 * Whether `answer` still answers `ask` now, inside the hold (past it, for an ask the user withdrew):
 * the decision the session itself named, unchanged (`said` with the id and decision key it had when it
 * was answered, so a new fact, deadline, option or link the session named is asked again: ask-decision.ts),
 * the same words, the same ask reworded (sameAskReworded), or one part of what it answered asked again
 * on its own (2026-11-05: Main answered six questions at once, and the task asked one of them again in
 * a letter of its own). An id Walnut kept from the words alone never holds it by itself: hiding an ask
 * needs more than keeping it quiet (2026-11-10, a review: a shared-word rule hid "delete production"
 * under an answer about staging). Pure.
 */
export function answerHolds(
  answer: AskAnswer | null | undefined, ask: string | null | undefined, nowMs = Date.now(),
  decision?: AnswerDecision | null,
): boolean {
  if (!answer || !ask) return false;
  const at = Date.parse(answer.at);
  // A withdrawal holds for good until the user writes in the task after it: then they brought it up.
  const withdrawn = !!answer.withdrawn && !(decision?.personAt && decision.personAt > answer.at);
  if (!Number.isFinite(at) || (!withdrawn && nowMs - at > ASK_ANSWER_HOLD_MS)) return false;
  const sameId = !!decision?.id && !!answer.askId && decision.id.toLowerCase() === answer.askId.toLowerCase();
  // The same decision with a new fact since (a revision, deadline, option or link): asked again,
  // whatever its words.
  if (sameId && decision!.key && answer.decisionKey && decision!.key !== answer.decisionKey) return false;
  if (sameId && decision!.said && decision!.key && decision!.key === answer.decisionKey) return true;
  if (askKey(ask) === answer.key || sameAskReworded(answer.ask, ask)) return true;
  return askIsPartOf(ask, answer.ask);
}

/**
 * Whether `part` asks only what `whole` already asks: at least SAME_ASK_MIN_WORDS content words, all
 * of them in `whole`, the same numbers, and the same "not" (askShape). Pure.
 */
export function askIsPartOf(part: string, whole: string): boolean {
  const p = askShape(part);
  const w = askShape(whole);
  if (p.neg !== w.neg || p.words.length < SAME_ASK_MIN_WORDS) return false;
  const at = new Map(w.words.map((x, i) => [x, i] as const));
  // Every word in it; with a number, in the same order too, since a number belongs to the words
  // before it ("production database 1" is no part of "staging database 1 and production database
  // 2"); and pointing the same way ("from production to staging" is no part of "from staging to
  // production").
  const ordered = p.words.some((x) => x.startsWith('#'));
  let last = -1;
  for (const x of p.words) {
    const i = at.get(x);
    if (i === undefined || (ordered && i < last)) return false;
    last = i;
  }
  return !p.links || !w.links || pointsWithin(p.links, w.links);
}

/** The answer of `answers` that still answers `ask` now, or null. Pure. */
export function answerFor(
  answers: readonly (AskAnswer | null | undefined)[], ask: string | null | undefined, nowMs = Date.now(),
  decision?: AnswerDecision | null,
): AskAnswer | null {
  for (const a of answers) if (answerHolds(a, ask, nowMs, decision)) return a!;
  return null;
}

/**
 * The answers a task keeps once `answer` is recorded (Task.asks_answered, oldest first): it replaces an
 * earlier answer to the same ask, the newest ASKS_ANSWERED_MAX of them kept, except that an ask the
 * user withdrew for good stays withdrawn: a later plain answer to it never replaces that record, and
 * nothing pushes it out (one per ask: a withdrawal of the same ask replaces it). Pure.
 */
export function keptAnswers(prev: readonly AskAnswer[], answer: AskAnswer): AskAnswer[] {
  const others = prev.filter((a) => a.key !== answer.key || (a.withdrawn && !answer.withdrawn));
  const all = [...others, answer];
  const plain = all.filter((a) => !a.withdrawn).slice(-ASKS_ANSWERED_MAX);
  return all.filter((a) => a.withdrawn || plain.includes(a));
}

/** Every answer recorded on a task, newest first. */
export function answersOf(t: { ask_answered?: AskAnswer | null; asks_answered?: AskAnswer[] | null } | null | undefined): AskAnswer[] {
  const list = [...(t?.asks_answered ?? [])].reverse();
  if (t?.ask_answered && !list.some((a) => a.key === t.ask_answered!.key && a.at === t.ask_answered!.at)) list.unshift(t.ask_answered);
  return list;
}

/** Ask kinds only the user may approve: an answer in their place quotes their words (user_words). */
export const APPROVAL_KINDS: ReadonlySet<string> = new Set(['outward', 'spending', 'credentials', 'permissions', 'cloud_delete', 'irreversible']);

/** Walnut's line at the head of the answering message: the one time the asker is told. */
export function askAnswerLine(ask: string, byTitle: string): string {
  return `[Walnut: ${byTitle.replace(/\s+/g, ' ').slice(0, 80)} answers here, in the user's place, the ask you put to the user: "${ask.replace(/\s+/g, ' ').slice(0, 200)}". `
    + 'Walnut took it off the user\'s Needs you. Act on this answer and do not ask the user it again; if it leaves a different decision open, ask that one in its own words.]';
}

/** Its wait in words, after "Waiting on": its own next step, and who answered in the user's place, first. */
export function answeredWords(a: Pick<AskAnswer, 'byTitle' | 'text'>): string {
  return `its next step, answered by ${a.byTitle.replace(/\s+/g, ' ').slice(0, 80)} for you: ${a.text.replace(/\s+/g, ' ').slice(0, 160)}`;
}

/**
 * The status shown for a task whose own question a lead, VP or Main already answered for the user
 * (`answer`, Task.ask_answered): Waiting on itself to act on the answer, never Needs you, while it
 * asks the same in the same words. Any other status as derived. Only the session's own question: a
 * Board choice is answered on the Board, a prompt or a failure in the session. Pure.
 */
export function answeredAbove(
  derived: UserStatus, answers: AskAnswer | readonly AskAnswer[] | null | undefined, nowMs = Date.now(), personAt?: string,
): UserStatus {
  if (!answers || derived.state !== 'needs' || derived.source !== 'session' || !derived.ask) return derived;
  const answer = answerFor(Array.isArray(answers) ? answers : [answers as AskAnswer], derived.ask, nowMs, { ...derived.decision, ...(personAt ? { personAt } : {}) });
  if (!answer) return derived;
  return {
    state: 'waiting', kind: 'task', waitingOn: answeredWords(answer),
    answeredFor: { by: answer.by, byTitle: answer.byTitle, at: answer.at, ask: answer.ask, ...(answer.sessionId ? { sessionId: answer.sessionId } : {}) },
    ...(derived.now ? { now: derived.now } : {}),
    ...(derived.next ? { next: derived.next } : {}),
    ...(derived.now || derived.next ? reportSource(derived) : {}),
    ...(derived.at ? { at: derived.at } : {}),
    ...(derived.stale ? { stale: derived.stale } : {}),
    ...(derived.due ? { due: derived.due } : {}),
    ...(derived.asks ? { asks: derived.asks } : {}),
  };
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
  relation: 'ancestor' | 'descendant' | 'team' | 'elsewhere';
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
  ancestor: 'a task above this one', descendant: 'a subtask of this one', team: 'a task in this team', elsewhere: 'another task',
};

/** The refusal's words for an ask a lead, VP or Main already answered for the user. */
export function answeredAskMessage(answer: AskAnswer, what: 'letter' | 'report' | 'thread'): string {
  const verb = what === 'letter' ? 'Not sent' : what === 'thread' ? 'Not handed to the user' : 'Not put on the user';
  return `${verb}: ${answer.byTitle.replace(/\s+/g, ' ').slice(0, 80)} already answered this for the user (${answer.at.slice(0, 16).replace('T', ' ')} UTC), `
    + `when you asked "${answer.ask.replace(/\s+/g, ' ').slice(0, 160)}": "${answer.text.replace(/\s+/g, ' ').slice(0, 240)}". `
    + `Act on that answer. If it leaves a different decision open, ask that one in its own words, or pass same_ask_reason: one line (at least ${SAME_ASK_REASON_MIN} characters) saying why it is not answered.`;
}

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
