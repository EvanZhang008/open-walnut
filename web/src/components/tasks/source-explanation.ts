/**
 * The sentence the new project picker shows under its chips: what the chosen service is and who
 * can see what syncs there (2026-11-01: bare plugin names let private tasks be filed into a
 * tracker the user's team reads). Pure, so tests read it without React.
 */

/** Who reads a service: only the user, or other people too (unknown counts as shared). */
export type Audience = 'self' | 'shared';

/** Who can read a service, in one clause, from its audience (unknown counts as shared). */
export function audienceLine(audience: Audience | undefined): string {
  return audience === 'self' ? 'Only you can see what syncs there.' : 'Other people can see what syncs there.';
}

/** The sentence under the chips: what the chosen option is and who reads it. */
export function sourceExplanation(id: string, plugin: { name: string; description?: string; audience?: Audience } | undefined): string {
  if (id === 'local' || !plugin) return 'Local: tasks stay in Walnut and are never sent to another service.';
  const what = plugin.description?.trim() || `Tasks sync to ${plugin.name}.`;
  // A description that already says who reads it needs no second clause.
  return /\b(only you|can see|everyone|your team|others?)\b/i.test(what) ? what : `${what} ${audienceLine(plugin.audience)}`;
}
