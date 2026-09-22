export function orderedNavigationIds(saved: unknown, available: readonly string[]): string[] {
  const known = new Set(available);
  const prior = Array.isArray(saved) ? saved.filter((id): id is string => typeof id === 'string' && known.has(id)) : [];
  return [...new Set([...prior, ...available])];
}

export function moveNavigationId(ids: readonly string[], from: string, to: string): string[] {
  const source = ids.indexOf(from), target = ids.indexOf(to);
  if (source < 0 || target < 0 || source === target) return [...ids];
  const next = [...ids];
  next.splice(source, 1);
  next.splice(target, 0, from);
  return next;
}
