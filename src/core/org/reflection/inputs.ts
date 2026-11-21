/**
 * The reflection's inputs read from their stores' records: one mapping for the live server
 * (pipeline.ts defaultDeps) and the replay over a copy of a Walnut home (scripts/reflection-replay.mjs),
 * so both read the same fields the same way. Pure: records in, the candidate stage's shapes out;
 * anything malformed is left out, never thrown on.
 */
import type { SpokenMessage } from './signals.js';
import type { ReflectionThread } from './candidates.js';

/** Each rules part is cut to this, so one judge call stays near its budget whatever the files grow to. */
export const RULES_PART_MAX = 8000;

const str = (v: unknown): v is string => typeof v === 'string';
/** The pictures a message carried (their paths), when it carried any. */
const imagesOf = (v: unknown): { images?: string[] } => {
  const images = Array.isArray(v) ? v.filter(str).slice(0, 8) : [];
  return images.length ? { images } : {};
};
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' ? v as Record<string, unknown> : null);

/** A node's Threads (threads-model.ts OrgThread[]) as the candidate stage reads them. */
export function threadsFromRecords(threads: unknown): ReflectionThread[] {
  if (!Array.isArray(threads)) return [];
  return threads.flatMap((raw) => {
    const t = obj(raw);
    if (!t || !str(t.id)) return [];
    const messages = (Array.isArray(t.messages) ? t.messages : []).flatMap((rm) => {
      const m = obj(rm);
      if (!m || !str(m.id) || !str(m.at) || !str(m.text)) return [];
      const a = obj(m.answer);
      return [{
        id: m.id, at: m.at, text: m.text, ...(str(m.sid) ? { sid: m.sid } : {}), ...imagesOf(m.images),
        ...(a && str(a.text) && str(a.at) ? { answer: { text: a.text, at: a.at, ...(str(a.sid) ? { sid: a.sid } : {}) } } : {}),
      }];
    });
    const tasks = Array.isArray(t.tasks) ? t.tasks.filter(str) : [];
    const options = (Array.isArray(t.options) ? t.options : []).flatMap((ro) => {
      const o = obj(ro);
      return o && str(o.label) ? [{ label: o.label, ...(o.recommended === true ? { recommended: true } : {}) }] : [];
    });
    return [{
      id: t.id, title: str(t.title) ? t.title : '', messages, ...(tasks.length ? { tasks } : {}),
      ...(str(t.state) ? { state: t.state } : {}), ...(t.closed ? { closed: true } : {}), ...(str(t.reply) ? { reply: t.reply } : {}),
      ...(str(t.replyAt) ? { replyAt: t.replyAt } : {}), ...(str(t.reply_sid) ? { replySid: t.reply_sid } : {}),
      ...(str(t.updatedAt) ? { updatedAt: t.updatedAt } : {}), ...(options.length ? { options } : {}),
      ...(str(t.askId) ? { askId: t.askId } : {}),
      // Its card is another's: a task's own ask (judged as that ask), a letter or a choice it shows.
      ...(t.askOwner || t.reportAsk || t.letter || t.choice ? { cardOfOther: true } : {}),
    }];
  });
}

/** His messages to a task (user-asks-model.ts UserAsk[]) as the candidate stage reads them. */
export function messagesFromAsks(asks: unknown): Array<SpokenMessage & { sid?: string }> {
  if (!Array.isArray(asks)) return [];
  return asks.flatMap((raw) => {
    const a = obj(raw);
    return a && str(a.id) && str(a.at) && str(a.text) ? [{ id: a.id, at: a.at, text: a.text, ...(str(a.sid) ? { sid: a.sid } : {}), ...imagesOf(a.images) }] : [];
  });
}

/** The rules the judge reads: the user's standing rules and the node's memory, each headed and bounded. */
export function rulesTextOf(userRules: string, nodeMemory: string): string {
  const user = userRules.slice(0, RULES_PART_MAX);
  const memory = nodeMemory.slice(0, RULES_PART_MAX);
  return [user && `## The user's standing rules (USER.md)\n${user}`, memory && `## The lead's memory (MEMORY.md)\n${memory}`].filter(Boolean).join('\n\n');
}
