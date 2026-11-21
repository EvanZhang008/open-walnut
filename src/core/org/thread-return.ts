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
 * Why a node's write that puts the thread before him again is refused, or null. `handsToUser`: the
 * write moves it into needs; otherwise only a new set of choices while it waits on him is judged.
 */
export function returnRefusal(cur: OrgThread, patch: ThreadPatch, by: ThreadWriter, handsToUser: boolean): string | null {
  if (by === 'human') return null;
  // Choices replaced by others (taking them off, or adding them where there were none, keeps the decision).
  const next = Array.isArray(patch.options) ? (patch.options as Array<{ label?: unknown } | string>).map((o) => ({ label: typeof o === 'string' ? o : String(o?.label ?? '') })) : [];
  // A letter's card keeps the letter's buttons: a new summary there may ask another decision under them.
  // Only a write that keeps it in needs: answering him (answered), stepping aside (pending) never asks.
  const staysNeeds = patch.state === undefined || patch.state === 'needs';
  const rewritesLetter = !handsToUser && staysNeeds && cur.state === 'needs' && !!cur.letter && !cur.letter.done && typeof patch.reply === 'string' && patch.reply.trim() !== (cur.reply ?? '').trim();
  const rewritesChoice = rewritesLetter || (!handsToUser && staysNeeds && cur.state === 'needs' && next.length > 0 && !!cur.options?.length && !sameOptions(next, cur.options));
  if (!handsToUser && !rewritesChoice) return null;
  const his = lastHisMessage(cur);
  if (handsToUser && his && wroteSinceNeeds(cur) && (patch.since_you_wrote ?? '').trim().length < SINCE_MIN) {
    return `Not handed to the user: they wrote in this thread since it last waited on them ("${his.text.replace(/\s+/g, ' ').slice(0, 80)}"). `
      + 'Pass since_you_wrote: one line on what you did about their message (the answer to their question, what you checked or changed). '
      + 'Walnut puts it first on the card, under their words, then your summary with the decision.' + OLD_TOOLS;
  }
  if ((handsToUser ? wroteSinceNeeds(cur) : askedBefore(cur)) && patch.decision !== 'same' && patch.decision !== 'new') {
    return 'Not handed to the user: this thread asked them a decision before. Pass decision "same" when it asks that decision again '
      + '(in other words is fine), or "new" when it is another one.' + OLD_TOOLS;
  }
  if (patch.decision === 'new' && (handsToUser ? wroteSinceNeeds(cur) : askedBefore(cur))) {
    return 'Not handed to the user: a new decision is its own card, never a rewrite of this one. Answer their message here '
      + '(state answered, with since_you_wrote or the answer in your summary), then open the new decision with thread_create '
      + `naming this thread in supersedes ("${cur.id}") when it replaces what this one asked${cur.letter ? ` and its letter (${cur.letter.id})` : ''}.`;
  }
  return null;
}

/** The card's summary when it comes back after his words: his words, what was done since, then the decision. */
export function returnedReply(cur: Pick<OrgThread, 'messages'>, since: string, reply: string): string {
  const his = lastHisMessage(cur);
  const words = his ? his.text.replace(/\s+/g, ' ').trim() : '';
  const quote = words.length > 60 ? `${words.slice(0, 60)}...` : words;
  const zh = /[\u4e00-\u9fff]/.test(`${since}${reply}${words}`);
  const at = his ? his.at.slice(11, 16) : '';
  const head = zh
    ? `**\u4f60 ${at} \u8bf4\uff1a\u201c${quote}\u201d\u3002\u4e4b\u540e\u6211\u505a\u4e86\uff1a** ${since.trim()}`
    : `**You wrote at ${at} UTC: "${quote}". Since then:** ${since.trim()}`;
  const ask = zh ? '**\u73b0\u5728\u8981\u4f60\u51b3\u5b9a\uff1a**' : '**Now you decide:**';
  return `${head}\n\n${ask} ${reply.trim()}`;
}
