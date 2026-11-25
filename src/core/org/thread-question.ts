/**
 * Each question he asks is its own thread (experiment `threads_each_question`; 2026-11-25, the user,
 * after a question he typed in a node's chat was merged into the thread of an earlier one on the
 * same subject: "each question I ask needs to have one thread, otherwise how can I track").
 *
 * With the switch on, a chat message of his that asks a question (asksQuestion) opens a thread of
 * its own whatever came right before it (threads-model.ts fileMessage), and no step of Walnut and no
 * node puts it into or under another thread (threads-model.ts mergeThreads, ownQuestionRefusal): only
 * he can, or a repeat of the very same words. A remark that asks nothing keeps the old rules.
 *
 * Pure but for the switch, which the status sync and the prompt inputs set (experimental-cache.ts).
 * No store import here: the model and the stores import this.
 */
import { experimentCache } from '../experimental-cache.js';
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
 * The English interrogatives. why/how/what/which/who/whose/whom ask wherever they stand ("hey why
 * is it red", "the build is red why", "tell me which train is faster"): a statement that holds one
 * ("that is what I meant") only makes one more thread. The rest ask at a clause start: when/where
 * only before an auxiliary ("when will", "where is"), since "when it ends, tell me" is an
 * instruction; an auxiliary asks before its subject ("is the build green", "can you"), and do/have
 * only before i, you, we or they, since "do the dishes" and "have it run" are orders.
 */
const EN_WH = /\b(?:why|how|what|which|who|whose|whom)\b/i;
/**
 * An auxiliary before a pronoun asks wherever it stands ("for the charts is there a way to show
 * it", typed or spoken with no comma), and so does a closing tag ("it is still working right").
 * Not is/are before this or that ("the problem is that ..."), not do/have before it ("let's do it").
 */
const EN_AUX_ANYWHERE = new RegExp(String.raw`\b(?:(?:can|could|would|should|will|shall|does|did|${NEGATED})\s+(?:i|you|u|we|they|it|he|she|there|this|that)`
  + String.raw`|(?:is|are|was|were)\s+(?:i|you|u|we|they|it|he|she|there)|(?:do|have)\s+(?:i|you|u|we|they))\b`, 'i');
const EN_TAG = /\b(?:right|correct|or not)\s*[.!]*$/i;
const EN_QUESTION = new RegExp(CLAUSE + String.raw`(?:(?:when|where)(?:'s|\s+(?:is|are|was|were|will|would|can|could|should|do|does|did|has|have)\b)`
  + String.raw`|(?:can|could|would|should|will|shall|may|might|is|are|was|were|am|does|did|has|${NEGATED})\s+${SUBJECT}`
  + String.raw`|(?:do|have)\s+(?:i|you|we|they)\b)`, 'i');
/**
 * The Chinese question forms, anywhere in a clause (Chinese puts them where the asked thing is):
 * why (wei shen me, wei sha), how (zen me, zen yang, ru he), what (shen me, sha), whether (shi fou),
 * can or cannot, may or may not, is or is not, have or not, will or not, want or not, right or not,
 * good or not, how many (duo shao, ji ge), which or where (na), who (shui); and the particles ma and
 * ne at a clause's end.
 */
const ZH_QUESTION = new RegExp('\u4e3a\u4ec0\u4e48|\u4e3a\u5565|\u600e\u4e48|\u600e\u6837|\u5982\u4f55|\u4ec0\u4e48|\u5565|\u662f\u5426'
  + '|\u80fd\u4e0d\u80fd|\u53ef\u4e0d\u53ef\u4ee5|\u662f\u4e0d\u662f|\u6709\u6ca1\u6709|\u4f1a\u4e0d\u4f1a|\u8981\u4e0d\u8981|\u5bf9\u4e0d\u5bf9|\u597d\u4e0d\u597d'
  + '|\u591a\u5c11|\u51e0\u4e2a|\u54ea|\u8c01'
  + '|[\u5417\u5462](?=$|[\\s,.;:!~\u3001\uff0c\u3002\uff1b\uff1a\uff01\uff1f?])');
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
 * plain reaction. By form only, no model. Leans towards yes: a statement read as a question only
 * makes one more thread, a question read as a statement loses its thread. Pure.
 */
export function asksQuestion(text: string): boolean {
  const t = text.replace(LINK_OR_CODE, ' ').trim();
  if (!t || isPlainReaction(t) || !standsAlone(t)) return false;
  return /[?\uff1f]/.test(t) || EN_WH.test(t) || EN_AUX_ANYWHERE.test(t) || EN_TAG.test(t) || EN_QUESTION.test(t) || ZH_QUESTION.test(t);
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

/** With the switch on, `t` is a thread his question opened: never offered for a merge. */
export const isQuestionThread = (t: Pick<OrgThread, 'opener' | 'createdAt' | 'messages'>): boolean => eachQuestionNow() && !!ownQuestionOf(t);

/** What a node does with his question's thread instead of a merge (the status question and the refusal say it). */
export const OWN_QUESTION_DO = 'give it a title that says what this question asks, and answer it there';

/**
 * Why `from` may not go into `into`, with the switch on: it is a thread his question opened. He may
 * merge it himself, and the very same words already in `into` (a repeat of one question) may merge.
 * Null when the merge may go on. Pure but for the switch.
 */
export function ownQuestionRefusal(from: Pick<OrgThread, 'id' | 'opener' | 'createdAt' | 'messages'>, into: Pick<OrgThread, 'id' | 'messages'>, by: ThreadWriter): string | null {
  if (!eachQuestionNow() || by === 'human') return null;
  const q = ownQuestionOf(from);
  if (!q) return null;
  const said = wordsKey(q.text);
  if (into.messages.some((m) => wordsKey(m.text) === said)) return null;
  return `Thread ${from.id} is his own question, so it stays its own thread and does not go into ${into.id}: ${OWN_QUESTION_DO}.`;
}
