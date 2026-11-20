/**
 * The thread line on a history route's rows (experiment reply_thread_line,
 * src/core/org/reply-thread-index.ts): `res.json` of a body with `messages` resolves their threads
 * first, within withReplyThreads' own deadline, else serves them as they are (a route touching the
 * threads store answers on time). One wrap per response; the first body with rows is the one resolved.
 */
import type { Response } from 'express';
import { withReplyThreads, type ReplyRow } from '../../core/org/reply-thread-index.js';

export function replyThreadsOnJson(res: Response, ctx: { chat: string; sid?: string }): void {
  const json = res.json.bind(res);
  let pending = false;
  res.json = ((body: unknown) => {
    const rows = (body as { messages?: unknown } | null)?.messages;
    if (pending || !Array.isArray(rows) || !rows.length) return json(body);
    pending = true;
    let done = false;
    const send = (b: unknown) => { if (done || res.headersSent) return; done = true; json(b); };
    void withReplyThreads(rows as ReplyRow[], ctx).then((messages) => send({ ...(body as object), messages }), () => send(body));
    return res;
  }) as Response['json'];
}

