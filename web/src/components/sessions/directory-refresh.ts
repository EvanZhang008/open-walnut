import type { DirEntry } from '@/api/files';

export function visibleDirectoryPaths(
  roots: readonly string[],
  expanded: ReadonlySet<string>,
  children: ReadonlyMap<string, readonly DirEntry[]>,
): string[] {
  const seen = new Set<string>();
  const visit = (dir: string) => {
    if (seen.has(dir)) return;
    seen.add(dir);
    for (const entry of children.get(dir) ?? []) {
      if (entry.type !== 'dir') continue;
      const child = `${dir.replace(/\/$/, '')}/${entry.name}`;
      if (expanded.has(child)) visit(child);
    }
  };
  roots.forEach(visit);
  return [...seen];
}

export function removedDirectoryPaths(
  current: ReadonlyMap<string, readonly DirEntry[]>,
  listings: readonly { path: string; entries: DirEntry[] }[],
): string[] {
  return listings.flatMap(listing => {
    const directories = new Set(listing.entries.filter(entry => entry.type === 'dir').map(entry => entry.name));
    return (current.get(listing.path) ?? [])
      .filter(entry => entry.type === 'dir' && !directories.has(entry.name))
      .map(entry => `${listing.path.replace(/\/$/, '')}/${entry.name}`);
  });
}

export function applyDirectoryListings(
  current: Map<string, DirEntry[]>,
  listings: readonly { path: string; entries: DirEntry[] }[],
  roots: ReadonlySet<string> = new Set(),
): Map<string, DirEntry[]> {
  let next = current;
  const removed = removedDirectoryPaths(current, listings).filter(path => !roots.has(path));
  for (const path of current.keys()) {
    if (!removed.some(dir => path === dir || path.startsWith(`${dir}/`))) continue;
    if (next === current) next = new Map(current);
    next.delete(path);
  }
  for (const listing of listings) {
    if (removed.some(dir => listing.path === dir || listing.path.startsWith(`${dir}/`))) continue;
    const previous = current.get(listing.path);
    if (previous?.length === listing.entries.length && previous.every((entry, i) => {
      const fresh = listing.entries[i]!;
      return entry.name === fresh.name && entry.type === fresh.type && entry.size === fresh.size;
    })) continue;
    if (next === current) next = new Map(current);
    next.set(listing.path, listing.entries);
  }
  return next;
}
