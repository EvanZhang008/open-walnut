/**
 * A thread he wrote in comes back to him only on a card that starts from his words (2026-11-21, the
 * user, of a thread whose card kept asking a decision after he had written back three times, each
 * time with a question: "I already replied, why is it still there?").
 *
 * His message takes a thread out of needs (threads-model.ts fileMessage). A node that puts it back
 * in needs after it (or rewrites its decision while it waits on him) must:
 *   - say what it did since his message (`since_you_wrote`): Walnut puts that line first on the card,
 *     after his own words, so the card opens with his question answered, then the decision;
 *   - say whether this is the decision the thread asked before (`decision`: "same") or another one
 *     ("new"). A new decision is its own card (thread_create), never a rewrite of this one: here he
 *     gets the answer to his message (answered).
 * A letter's thread waiting on him carries the letter's buttons, so a new summary there says the
 * same (same or new) too. Pure; threads-model.ts updateThread calls it. Guard tests: tests/core/org/thread-return.test.ts.
 */
import type { OrgThread, ThreadPatch, ThreadWriter } from './threads-model.js';

/** For a session whose tool list predates these fields: the CLI always takes them. */
export const OLD_TOOLS = ' (Not in your tool list? walnut tools call thread_update \'{"id":"th-...","state":"needs","since_you_wrote":"...","decision":"same"}\'.)';

/** A line of what the node did since his message, at least this long. */
export const SINCE_MIN = 10;

const ms = (iso: string | undefined): number => { const n = Date.parse(iso ?? ''); return Number.isFinite(n) ? n : 0; };

/**
 * His latest words in the thread, if any: the newest by time, never a button he clicked (its label,
 * his answer: the next decision then is the node's next step) or a line an agent filed for him.
 */
export function lastHisMessage(t: Pick<OrgThread, 'messages'> & Partial<Pick<OrgThread, 'options' | 'letter'>>): { at: string; text: string } | null {
  const labels = new Set([...(t.options ?? []), ...(t.letter?.options ?? [])].map((o) => o.label.trim()));
  const words = t.messages.filter((m) => !labels.has(m.text.trim()) && (!m.delivery?.by || m.delivery.by === 'human'));
  const m = words.reduce<typeof words[number] | undefined>((a, b) => (!a || ms(b.at) >= ms(a.at) ? b : a), undefined);
  return m ? { at: m.at, text: m.text } : null;
}

/** The thread already asked him a decision: it waited on him before, or it holds a letter's choice. */
function askedBefore(t: Pick<OrgThread, 'needsAt' | 'letter' | 'options'>): boolean {
  return !!t.needsAt || !!t.letter || !!t.options?.length;
}

/**
 * It asked him before and he wrote since: putting it before him again is a return. A first ask
 * after his request (a thread his message opened) is not one: his words are what it answers.
 */
export function wroteSinceNeeds(t: Pick<OrgThread, 'messages' | 'needsAt' | 'letter' | 'options'>): boolean {
  const his = lastHisMessage(t);
  return !!his && askedBefore(t) && (!t.needsAt || ms(his.at) > ms(t.needsAt));
}

const sameOptions = (a: ReadonlyArray<{ label: string }> | undefined, b: ReadonlyArray<{ label: string }> | undefined): boolean =>
  (a ?? []).map((o) => o.label).join('\n') === (b ?? []).map((o) => o.label).join('\n');

/**
 * Which rule a write that puts the thread before him again meets first, or null: `since` (he wrote
 * since it last waited, and the write says nothing of it), `decision` (it asked before, and the
 * write says not whether this is that decision), `new` (another decision: its own card, never a
 * rewrite of this one). `handsToUser`: the write moves it into needs; otherwise only a new set of
 * choices while it waits on him is judged. Pure; returnRefusal says it in the op's words, a card
 * line in its own (reply-card-decision.ts).
 */
export function returnLack(cur: OrgThread, patch: ThreadPatch, by: ThreadWriter, handsToUser: boolean): ReturnLack | null {
  if (by === 'human') return null;
  // Choices replaced by others (taking them off, or adding them where there were none, keeps the decision).
  const next = Array.isArray(patch.options) ? (patch.options as Array<{ label?: unknown } | string>).map((o) => ({ label: typeof o === 'string' ? o : String(o?.label ?? '') })) : [];
  // A letter's card keeps the letter's buttons: a new summary there may ask another decision under them.
  // Only a write that keeps it in needs: answering him (answered), stepping aside (pending) never asks.
  const staysNeeds = patch.state === undefined || patch.state === 'needs';
  const rewritesLetter = !handsToUser && staysNeeds && cur.state === 'needs' && !!cur.letter && !cur.letter.done && typeof patch.reply === 'string' && patch.reply.trim() !== (cur.reply ?? '').trim();
  const rewritesChoice = rewritesLetter || (!handsToUser && staysNeeds && cur.state === 'needs' && next.length > 0 && !!cur.options?.length && !sameOptions(next, cur.options));
  if (!handsToUser && !rewritesChoice) return null;
  const asked = handsToUser ? wroteSinceNeeds(cur) : askedBefore(cur);
  if (handsToUser && lastHisMessage(cur) && asked && (patch.since_you_wrote ?? '').trim().length < SINCE_MIN) return 'since';
  if (asked && patch.decision !== 'same' && patch.decision !== 'new') return 'decision';
  return patch.decision === 'new' && asked ? 'new' : null;
}

export type ReturnLack = 'since' | 'decision' | 'new';

/**
 * Every rule a write meets, in one go: each one in turn as if the ones before were met, so a writer
 * with one chance to fix it (a card line's one send-back) hears all of them. `new` ends the list. Pure.
 */
export function returnLacks(cur: OrgThread, patch: ThreadPatch, by: ThreadWriter, handsToUser: boolean): ReturnLack[] {
  const out: ReturnLack[] = [];
  let p = patch;
  for (let lack = returnLack(cur, p, by, handsToUser); lack && !out.includes(lack); lack = returnLack(cur, p, by, handsToUser)) {
    out.push(lack);
    if (lack === 'new') break;
    p = lack === 'since' ? { ...p, since_you_wrote: '.'.repeat(SINCE_MIN) } : { ...p, decision: 'same' };
  }
  return out;
}

/** Why a node's write that puts the thread before him again is refused, or null (returnLack, in the op's words). */
export function returnRefusal(cur: OrgThread, patch: ThreadPatch, by: ThreadWriter, handsToUser: boolean): string | null {
  const lack = returnLack(cur, patch, by, handsToUser);
  if (lack === 'since') {
    const his = lastHisMessage(cur)!;
    return `Not handed to the user: they wrote in this thread since it last waited on them ("${his.text.replace(/\s+/g, ' ').slice(0, 80)}"). `
      + 'Pass since_you_wrote: one line on what you did about their message (the answer to their question, what you checked or changed). '
      + 'Walnut puts it first on the card, under their words, then your summary with the decision.' + OLD_TOOLS;
  }
  if (lack === 'decision') {
    return 'Not handed to the user: this thread asked them a decision before. Pass decision "same" when it asks that decision again '
      + '(in other words is fine), or "new" when it is another one.' + OLD_TOOLS;
  }
  if (lack === 'new') {
    return 'Not handed to the user: a new decision is its own card, never a rewrite of this one. Answer their message here '
      + '(state answered, with since_you_wrote or the answer in your summary), then open the new decision with thread_create '
      + `naming this thread in supersedes ("${cur.id}") when it replaces what this one asked${cur.letter ? ` and its letter (${cur.letter.id})` : ''}.`;
  }
  return null;
}

/**
 * The card's summary when it comes back after his words: the decision first, then what was done
 * since he wrote. Never his words again (2026-11-23, the user, on a card that opened with his own
 * voice message quoted: "it repeats my question completely ... my words are sometimes messy, that
 * is not needed; summarize it, or just say the matter").
 */
export function returnedReply(cur: Pick<OrgThread, 'messages'>, since: string, reply: string): string {
  const his = lastHisMessage(cur);
  const zh = /[\u4e00-\u9fff]/.test(`${since}${reply}${his?.text ?? ''}`);
  const at = his ? his.at.slice(11, 16) : '';
  const head = zh
    ? `**\u4f60 ${at} \u7559\u8a00\u4e4b\u540e\uff1a**`
    : `**Since your message at ${at} UTC:**`;
  return `${reply.trim()}\n\n${head} ${since.trim()}`;
}
