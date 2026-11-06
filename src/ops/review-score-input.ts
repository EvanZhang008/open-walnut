import { z } from 'zod';
import { scoreProblem } from '../core/peers/structured-reply.js';

/**
 * The `score` input of every op that takes a review's verdict (task_send, task_complete): the same
 * rule the HTTP routes and the offline host apply (structured-reply.ts scoreProblem). An object of
 * function / ux / ui in any key case, or the text "n/n/n", each 0..10; an unknown key, a part out of
 * range or an empty part is refused, never dropped (2026-11-06: {"UX": 8} was taken and lost).
 */
export const REVIEW_SCORE_INPUT = z
  .union([z.record(z.string(), z.union([z.number(), z.string()])), z.string()])
  .superRefine((v, ctx) => {
    const problem = scoreProblem(v);
    if (problem) ctx.addIssue({ code: 'custom', message: problem });
  });
