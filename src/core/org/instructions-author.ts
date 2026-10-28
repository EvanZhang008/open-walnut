/**
 * Who wrote a node's instructions (Task.org_instructions `by`): the user, an agent's task, or an
 * agent Walnut could not place. 2026-10-27, the user: "all human action can be done by agent also",
 * so the CEO and any agent may write them too; the Org page and the prompt say who did, and when.
 * A row without `by` predates agents writing them: the user wrote it.
 *
 * Pure and shared: the web imports it through `@open-walnut/org-tree`.
 */
export type OrgInstructionsWriter = 'human' | 'agent' | `task:${string}`;

export interface OrgInstructionsStamp {
  text: string;
  at: string;
  by?: OrgInstructionsWriter;
  /** The writer as a person reads it when it wrote ("the CEO", "the Growth VP", `the task "…"`). */
  by_name?: string;
  /** An agent wrote them because the user asked (it passed override_user): they count as the user's. */
  for_user?: boolean;
}

/**
 * The writer of `ins` as the user reads it: "you", or the agent's name when it wrote. `usersWords`:
 * the words count as the user's (the user wrote them, or asked the agent for them), so they replace
 * Walnut's default and no other agent replaces them without the user's word.
 */
export function orgInstructionsAuthor(ins: { by?: string; by_name?: string; for_user?: boolean } | null | undefined): { byUser: boolean; usersWords: boolean; who: string } {
  if (!ins?.by || ins.by === 'human') return { byUser: true, usersWords: true, who: 'you' };
  return { byUser: false, usersWords: ins.for_user === true, who: ins.by_name?.trim() || 'an agent' };
}
