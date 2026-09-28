/**
 * "A folder is a project": which project a launch from a folder files under.
 *
 *  1. A project declares EXACTLY this folder as its `default_cwd` → that project
 *     (the first in registry order when two do, as the draft picks). A parent
 *     folder's project is never inherited: a team folder inside a shared
 *     checkout used to land in the checkout's project, which nobody asked for
 *     (2026-09-28).
 *  2. Otherwise a NEW project named after the folder. When another project
 *     already has that name, the name grows until it is free: the parent
 *     folder's name in front, then the host after it (remote launches only),
 *     then a number.
 *
 * The draft column computes the same thing to show the pill before Start
 * (`projectForFolderPick` in web/src/components/sessions/draft-column.ts; a
 * parity test holds the two together). The server's answer is the one that
 * counts: a window running an older bundle, or two drafts on two folders of
 * the same name started one after the other, can carry a name that another
 * folder already owns.
 */

/** Paths compare verbatim (they are case-sensitive) minus trailing slashes. */
export function trimDir(dir: unknown): string {
  return typeof dir === 'string' ? dir.replace(/\/+$/, '') : '';
}

/**
 * The name a folder's NEW project gets, or null when the folder's own name
 * could never name a project (`isValid` is the registry's name gate). Each step
 * keeps the previous one, so a name says more the more it had to be told apart:
 * `marina` → `acme-marina` → `acme-marina (devbox)` → `acme-marina (devbox) 2`.
 * `isTaken` is case-insensitive project identity.
 */
export function folderProjectName(
  cwd: string,
  host: string | null | undefined,
  isTaken: (name: string) => boolean,
  isValid: (name: string) => boolean,
): string | null {
  const parts = trimDir(cwd).split('/').filter(Boolean);
  // Trimmed: the registry trims names, so ' kelp ' would land on 'kelp'.
  const base = (parts[parts.length - 1] ?? '').trim();
  if (!isValid(base)) return null;
  const candidates = [base];
  const parent = parts[parts.length - 2]?.trim();
  if (parent && isValid(`${parent}-${base}`)) candidates.push(`${parent}-${base}`);
  const remote = host && host !== '__local__' ? host : '';
  const withHost = `${candidates[candidates.length - 1]} (${remote})`;
  if (remote && isValid(withHost)) candidates.push(withHost);
  for (const name of candidates) if (!isTaken(name)) return name;
  const last = candidates[candidates.length - 1];
  for (let n = 2; ; n++) {
    const name = `${last} ${n}`;
    if (!isValid(name)) return null;
    if (!isTaken(name)) return name;
  }
}

/** The project a launch from `cwd` on `host` files under (rules above). */
export function folderProjectFor(
  projects: Record<string, { metadata?: Record<string, unknown> }>,
  cwd: string,
  host: string | null | undefined,
  isValid: (name: string) => boolean,
): string | null {
  const dir = trimDir(cwd);
  if (!dir) return null;
  // Registry order (the list the draft reads), so both pick the same declarer.
  const names = Object.keys(projects);
  const owner = names.find((name) => trimDir(projects[name].metadata?.default_cwd) === dir);
  if (owner) return owner;
  const taken = new Set(names.map((name) => name.toLowerCase()));
  return folderProjectName(dir, host, (name) => taken.has(name.toLowerCase()), isValid);
}
