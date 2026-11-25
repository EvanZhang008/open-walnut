/**
 * Each question he asks is its own thread (experiment `threads_each_question`; 2026-11-25, the user,
 * after a question he typed in a node's chat was merged into the thread of an earlier one on the
 * same subject: "each question I ask needs to have one thread, otherwise how can I track").
 *
 * With the switch on, a chat message of his that asks a question (asksQuestion) opens a thread of
 * its own whatever came right before it (threads-model.ts fileMessage), and no step of Walnut and no
 * node puts it into or under another thread while it waits for its answer (threads-model.ts
 * mergeThreads, ownQuestionRefusal): only he can, or a repeat of the very same words. A remark that
 * asks nothing keeps the old rules.
 *
 * Once its answer is in, it may join a thread on the same matter, and at any time when he asked for
 * it in his own words (2026-11-25, the same day: he typed one question as two messages seconds
 * apart, both were answered alike, and with a third card on that matter his Done read "look all
 * duplicated ... you need to combine them"; the node's merge was refused three times). What the
 * rule guards is a question of his going out of his sight unanswered, never two cards on one matter.
 *
 * Pure but for the switch, which the status sync and the prompt inputs set (experimental-cache.ts).
 * No store import here: the model and the stores import this.
 */
import { experimentCache } from '../experimental-cache.js';
import { parseCardAnswer } from '../user-status.js';
import type { OrgThread, ThreadMessage, ThreadWriter } from './threads-model.js';

const flag = experimentCache('threads_each_question');
/** The experiment as last read (user-status-sync.ts and prompt-inputs.ts set it). */
export const setEachQuestion = flag.set;
export const eachQuestionNow = flag.now;
/** The experiment, read from the config now. */
export const eachQuestionOn = flag.on;

/** Words compared as he wrote them, case and spacing aside. */
export const wordsKey = (s: string): string => s.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();

/** A whole message that only reacts: a word or two of thanks, ok or done, no question (filing only; isAcknowledgement is the looser close check). */
const PLAIN_REACTION = /^(?:done|ok|okay|k|thanks|thank you|thx|got it|great|nice|good|cool|perfect|sounds good|lgtm|\u597d|\u597d\u7684|\u884c|\u53ef\u4ee5|\u6536\u5230|\u8c22\u8c22|\u77e5\u9053\u4e86|\u660e\u767d|\u6ca1\u95ee\u9898|\u5b8c\u6210|\u641e\u5b9a|\ud83d\udc4d)(?:[\s,.!\uff0c\u3002\uff01~]*(?:thanks|thank you|\u8c22\u8c22|\ud83d\udc4d))?[\s.!\uff01\u3002~]*$/i;
export function isPlainReaction(text: string): boolean {
  return PLAIN_REACTION.test(text.trim());
}

const CJK = /[\u3400-\u9fff\uf900-\ufaff]/g;
/** Where a clause starts: the message's start, a stop or comma, or a joining word ("and", "so", ...). */
const CLAUSE = String.raw`(?:^|[,.;:!\n\u3001\uff0c\u3002\uff1b\uff1a\uff01]\s*|\b(?:and|so|but|or|then|also|ok|okay|well|wait|hmm|now|plus)\s+)`;
/** A subject after an auxiliary: a pronoun, or a determiner and a word. */
const PRONOUN = 'i|you|he|she|it|we|they|this|that|these|those|there|anyone|anything|someone|something';
const DETERMINER = 'the|a|an|my|your|our|his|her|their|its|any|some|all|every|each';
const SUBJECT = String.raw`(?:(?:${PRONOUN})\b|(?:${DETERMINER})\s+[a-z0-9])`;
const NEGATED = "isn't|aren't|wasn't|weren't|don't|doesn't|didn't|won't|can't|couldn't|wouldn't|shouldn't|haven't|hasn't";
/**
 * The English interrogatives. why/how/what/which/who/whose/whom ask at a clause start, and wherever
 * else they stand ("hey why is it red", "the build is red why", "tell me which train is faster")
 * unless the word before makes them part of a statement ("that is how it works", "do what you
 * think is best", "I know why"). when/where ask only at a clause start before an auxiliary ("when
 * will", "where is"), since "when it ends, tell me" is an instruction; an auxiliary asks before its
 * subject ("is the build green", "can you"), and do/have only before i, you, we or they, since "do
 * the dishes" and "have it run" are orders.
 */
const WH = 'why|how|what|which|who|whose|whom';
const EN_WH_START = new RegExp(CLAUSE + String.raw`(?:${WH})\b`, 'i');
const EN_WH_AFTER = new RegExp(String.raw`(\S+)\s+(?:${WH})\b`, 'gi');
const STATES = new Set(['is', 'are', 'was', 'were', 'be', 'am', 'do', 'does', 'did', 'know', 'knows', 'knew', 'see', 'sees', 'saw', 'understand',
  'remember', 'about', 'of', 'for', 'on', 'in', 'to', 'with', 'from', 'that', 'exactly', 'matter', 'not']);
const bare = (w: string): string => w.toLowerCase().replace(/[^a-z']/g, '');
function whAsks(t: string): boolean {
  if (EN_WH_START.test(t)) return true;
  for (const m of t.matchAll(EN_WH_AFTER)) if (!STATES.has(bare(m[1]))) return true;
  return false;
}
/**
 * An auxiliary that asks wherever it stands, typed or spoken with no comma before it: "for the
 * charts is there a way to show it", "and after lunch can we repaint it". Only the forms a statement
 * rarely holds: not "the bug is there too", "I did it already", "the problem is that ...".
 */
const EN_AUX_ANYWHERE = new RegExp(String.raw`\b(?:(?:is|are|was|were)\s+there\s+(?:a|an|any|some|no|anything|something|anyone|someone|more|another|enough)\b`
  + String.raw`|(?:can|could|should|shall|would|will)\s+(?:i|you|u|we)\b|(?:do|did|does)\s+(?:you|u|we)\b|(?:is|are|was|were)\s+(?:you|u|we|they)\b`
  + String.raw`|(?:does|will|can|could|would|should)\s+it\b)`, 'i');
/** A closing tag asks ("it is still working right"), unless it closes an agreement ("you are right", "that is correct"). */
const EN_TAG = /(\S+)\s+(?:right|correct)\s*[.!]*$/i;
const AGREES = new Set(['is', 'are', 'was', 'were', 'be', 'am', "that's", 'thats', "you're", 'youre', "it's", 'its', 'sounds', 'seems', 'looks', 'feels',
  'all', 'not', 'quite', 'absolutely', 'exactly', 'totally', 'turn', 'go', 'the', 'on', 'to']);
function tagAsks(t: string): boolean {
  if (/\bor not\s*[.!]*$/i.test(t)) return true;
  const m = EN_TAG.exec(t);
  return !!m && !AGREES.has(bare(m[1]));
}
const EN_QUESTION = new RegExp(CLAUSE + String.raw`(?:(?:when|where)(?:'s|\s+(?:is|are|was|were|will|would|can|could|should|do|does|did|has|have)\b)`
  + String.raw`|(?:can|could|would|should|will|shall|may|might|is|are|was|were|am|does|did|has|${NEGATED})\s+${SUBJECT}`
  + String.raw`|(?:do|have)\s+(?:i|you|we|they)\b)`, 'i');
/**
 * The Chinese question forms, anywhere in a clause (Chinese puts them where the asked thing is):
 * why (wei shen me, wei sha), how (zen me, zen yang, ru he), what (shen me, sha), whether (shi fou),
 * can or cannot, may or may not, is or is not, have or not, will or not, want or not, right or not,
 * good or not, how many or how long (duo shao, duo jiu, duo chang, ji, never ji hu "almost"), which
 * or where (na), who (shui), the short forms (za, gan ma, neng fou, ke fou, wei he, xing bu xing,
 * dui ba, shi ba); and the particles ma and ne, or "le mei (you)", at a clause's end.
 */
const ZH_QUESTION = new RegExp('\u4e3a\u4ec0\u4e48|\u4e3a\u5565|\u600e\u4e48|\u600e\u6837|\u5982\u4f55|\u4ec0\u4e48|\u5565|\u662f\u5426'
  + '|\u80fd\u4e0d\u80fd|\u53ef\u4e0d\u53ef\u4ee5|\u662f\u4e0d\u662f|\u6709\u6ca1\u6709|\u4f1a\u4e0d\u4f1a|\u8981\u4e0d\u8981|\u5bf9\u4e0d\u5bf9|\u597d\u4e0d\u597d'
  + '|\u591a\u5c11|\u591a\u4e45|\u591a\u957f|\u591a\u5927|\u591a\u5feb|\u591a\u8fdc|\u51e0(?!\u4e4e)|\u54ea|\u8c01'
  + '|\u548b|\u5e72\u561b|\u80fd\u5426|\u53ef\u5426|\u4e3a\u4f55|\u884c\u4e0d\u884c|\u5bf9\u5427|\u662f\u5427'
  + '|(?:[\u5417\u5462]|\u4e86\u6ca1\u6709?)(?=$|[\\s,.;:!~\u3001\uff0c\u3002\uff1b\uff1a\uff01\uff1f?])');
const LINK_OR_CODE = /https?:\/\/\S+|`[^`]*`/g;

/** Long enough to stand alone: three words, or four CJK characters. "why?" or "really?" is a reaction to what was just said. */
function standsAlone(text: string): boolean {
  const cjk = text.match(CJK)?.length ?? 0;
  const words = text.replace(CJK, ' ').match(/[\p{L}\p{N}][\p{L}\p{N}'_-]*/gu)?.length ?? 0;
  return words >= 3 || cjk >= 4;
}

/**
 * Whether his message is a question of its own: a question mark (a link's or code's left aside), an
 * English interrogative, or a Chinese question form; long enough to stand alone; never a
 * plain reaction, never his answer from a card. By form only, no model. Leans towards yes: a statement read as a question only
 * makes one more thread, a question read as a statement loses its thread. Pure.
 */
export function asksQuestion(text: string): boolean {
  // His answer from a card (`Answer to "<ask>": <words>`) answers a question, it asks none: the
  // quoted ask is the agent's, and whatever he adds is about that ask (2026-11-25: such an answer
  // opened a thread of its own for the ask's question mark, a second card for one matter).
  if (parseCardAnswer(text)) return false;
  const t = text.replace(LINK_OR_CODE, ' ').trim();
  if (!t || isPlainReaction(t) || !standsAlone(t)) return false;
  return /[?\uff1f]/.test(t) || whAsks(t) || EN_AUX_ANYWHERE.test(t) || tagAsks(t) || EN_QUESTION.test(t) || ZH_QUESTION.test(t);
}

/**
 * The question of his that opened `t`: its first message (filed at its creation), when it asks one.
 * Not a thread the node opened, not a letter's answer, and never a message moved in later (merged
 * in, or a word he added after: those keep the old rules). Pure.
 */
export function ownQuestionOf(t: Pick<OrgThread, 'opener' | 'createdAt' | 'messages'>): ThreadMessage | undefined {
  if (t.opener) return undefined;
  const m = t.messages.find((x) => x.at === t.createdAt);
  return m && (m.via === 'chat' || m.via === 'follow-up' || m.via === 'split') && asksQuestion(m.text) ? m : undefined;
}

/** The states he does not see (thread-groups.ts folds them): his question there still waits for its answer. */
const AWAITS_ANSWER: ReadonlySet<OrgThread['state']> = new Set(['new', 'working', 'pending']);

/**
 * With the switch on, `t` is a thread his question opened that still waits for its answer: never
 * offered for a merge. Once answered (or asking him) it is a thread like any other: one on the same
 * matter is offered, so his Done never holds two cards on one thing.
 */
export const isQuestionThread = (t: Pick<OrgThread, 'opener' | 'createdAt' | 'messages' | 'state'>): boolean =>
  eachQuestionNow() && AWAITS_ANSWER.has(t.state) && !!ownQuestionOf(t);

/** What a node does with his question's thread instead of a merge (the status question and the refusal say it). */
export const OWN_QUESTION_DO = 'give it a title that says what this question asks, and answer it there';

/**
 * Why `from` may not go into `into`, with the switch on: it is a thread his question opened, and the
 * question still waits for its answer, so joining another card would take it out of his sight. He may
 * merge it himself; the very same words already in `into` (a repeat of one question) may merge; a
 * question whose answer is in (answered, or asking him: needs) may join a thread on the same matter;
 * and so may any when he asked for it in his own words (`heAsked`: mergeThreads read the node's
 * user_words in a message of his). Null when the merge may go on. Pure but for the switch.
 */
export function ownQuestionRefusal(
  from: Pick<OrgThread, 'id' | 'opener' | 'createdAt' | 'messages' | 'state'>, into: Pick<OrgThread, 'id' | 'messages'>, by: ThreadWriter, heAsked = false,
): string | null {
  if (!eachQuestionNow() || by === 'human' || heAsked) return null;
  const q = ownQuestionOf(from);
  if (!q || !AWAITS_ANSWER.has(from.state)) return null;
  const said = wordsKey(q.text);
  if (into.messages.some((m) => wordsKey(m.text) === said)) return null;
  return `Thread ${from.id} is his own question and still waits for its answer, so it stays its own thread and does not go into ${into.id}: ${OWN_QUESTION_DO}. `
    + 'Once it is answered it may join a thread on the same matter; before that only when he asked you to combine them: send merge_into with user_words quoting his words.';
}
