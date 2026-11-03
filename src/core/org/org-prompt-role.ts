/**
 * The org role a session runs as, read from the prompt Walnut gave it (sessions/session-context.ts
 * orgRoleLine). The spawn reads it to give Main's and a VP's session the hooks that remind them of their
 * first rule (providers/org-work-guard-hook.ts). From the prompt, not the task: a spawn is synchronous
 * and has only its arguments, and a resume replays the prompt the session was spawned with, which is
 * the role it was told it has. Walnut writes this prompt, so its words are Walnut's own format.
 *
 * Every opening orgRoleLine has used is listed, the oldest too: a session spawned before a rewording
 * keeps its old prompt (2026-11-03: the Walnut VP still ran on its prompt as "Walnut lead").
 * tests/core/org/org-self-work-rule.test.ts composes every role variant and fails on one this misses.
 */
import type { OrgRole } from '../types.js';

const MAIN = /(^|\n)You are the user's main agent: /;
const LEAD = /(^|\n)(The user calls you the "[^\n]*?" VP\. )?Your task is (the lead of (project|projects) |the VP of (project|projects) |a VP with no project yet: )/;

export function orgRoleOfPrompt(prompt: string | undefined): OrgRole | undefined {
  if (!prompt) return undefined;
  if (MAIN.test(prompt)) return 'main';
  if (LEAD.test(prompt)) return 'lead';
  return undefined;
}
