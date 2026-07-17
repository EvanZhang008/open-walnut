/**
 * Input-state classification for the session path selector.
 *
 * Four states (converged product design — see plan):
 *   browse         "walnut"          not / or ~ → fuzzy over history only
 *   dir-browse     "/a/b/c/"         trailing slash → all direct children of c/
 *   segment        "/a/b/c"          last segment fuzzy-completes against b/'s children
 *   scoped-search  "/a/b keyword"    keyword fuzzy-searched under base /a/b
 *
 * Pure functions — no React, no IO. Unit-tested in tests/web/path-selector/.
 */

export type InputState =
  | { kind: 'browse'; query: string }
  | { kind: 'dir-browse'; dir: string }
  | { kind: 'segment'; dir: string; partial: string }
  | { kind: 'scoped-search'; base: string; keyword: string };

function isPathLike(raw: string): boolean {
  return raw.startsWith('/') || raw.startsWith('~');
}

/** Classify raw input into one of the four states.
 *  Space rule: the token after the LAST space is a keyword only if it contains
 *  no '/' — paths with spaces in dir names are resolved later against live data
 *  (see resolveSpaceAmbiguity). */
export function classifyInput(raw: string): InputState {
  if (!isPathLike(raw)) return { kind: 'browse', query: raw };

  const lastSpace = raw.lastIndexOf(' ');
  if (lastSpace > 0) {
    const before = raw.slice(0, lastSpace);
    const after = raw.slice(lastSpace + 1);
    // keyword must be non-empty and contain no '/' — otherwise treat the whole
    // string as a path (dir names can contain spaces).
    if (after.length > 0 && !after.includes('/') && isPathLike(before)) {
      const base = before.endsWith('/') ? before : before + '/';
      return { kind: 'scoped-search', base, keyword: after };
    }
  }

  if (raw.endsWith('/')) return { kind: 'dir-browse', dir: raw };

  const lastSlash = raw.lastIndexOf('/');
  // "~" alone (no slash yet) — treat as segment under root-ish; practically the
  // caller lists '~/'. Keep dir='' guard: no slash → browse fallback.
  if (lastSlash < 0) return { kind: 'browse', query: raw };
  return {
    kind: 'segment',
    dir: raw.slice(0, lastSlash + 1),
    partial: raw.slice(lastSlash + 1),
  };
}

/**
 * Space-ambiguity resolution once live children of the base are known:
 * if a literal child named "<lastSegOfBase><space><keyword>" exists, the space
 * was part of a real directory name — reclassify as segment/dir-browse.
 * `childrenOfBase` are full paths of the base dir's direct children.
 */
export function resolveSpaceAmbiguity(state: InputState, childrenOfBase: string[]): InputState {
  if (state.kind !== 'scoped-search') return state;
  // Reconstruct the raw-ish path "base + keyword" — if the base's parent has a
  // child literally matching it, prefer the path interpretation.
  const literal = state.base.replace(/\/$/, '') + ' ' + state.keyword;
  const literalLower = literal.toLowerCase();
  for (const child of childrenOfBase) {
    const childLower = child.replace(/\/$/, '').toLowerCase();
    if (childLower === literalLower) {
      return { kind: 'dir-browse', dir: child.endsWith('/') ? child : child + '/' };
    }
    if (childLower.startsWith(literalLower)) {
      // A child extends the spaced string → the user is mid-typing a spaced dir name
      const lastSlash = literal.lastIndexOf('/');
      return { kind: 'segment', dir: literal.slice(0, lastSlash + 1), partial: literal.slice(lastSlash + 1) };
    }
  }
  return state;
}

/** Cmd+Backspace: delete the last path segment, keeping the trailing slash.
 *  '/a/b/c' → '/a/b/', '/a/b/c/' → '/a/b/', '/a' → '/', '/' → '/', '~/x' → '~/'. */
export function deleteLastSegment(path: string): string {
  if (!path) return path;
  let p = path;
  // strip trailing slashes (but keep a lone '/')
  while (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  const lastSlash = p.lastIndexOf('/');
  if (lastSlash < 0) return ''; // no slash at all (e.g. '~') → clear
  return p.slice(0, lastSlash + 1);
}

/** The directory whose children should be live-listed for a given state.
 *  browse → null (no live listing). */
export function parentDirOf(state: InputState): string | null {
  switch (state.kind) {
    case 'browse': return null;
    case 'dir-browse': return state.dir;
    case 'segment': return state.dir;
    case 'scoped-search': return state.base;
  }
}

/** Minimal live-listing shape pathValidity needs (structural subset of
 *  useLiveDirs' HostLiveState so this module stays React/IO-free). */
export interface HostListingLite {
  status: 'loading' | 'done' | 'error';
  parent: string;
  exists: boolean;
  dirs: string[];
}

/**
 * Does the typed path exist, according to the settled live listings?
 *   'valid'   — at least one host confirms the exact directory exists
 *   'missing' — every host settled and none has it (create & start territory)
 *   'unknown' — still loading, listing errored, or state has no path verdict
 *               (browse / scoped-search)
 * Drives the input's status button: never block on 'unknown' (an unreachable
 * host must not stop a user who knows the path is right).
 */
export function pathValidity(state: InputState, hosts: Iterable<HostListingLite>): 'valid' | 'missing' | 'unknown' {
  if (state.kind === 'browse' || state.kind === 'scoped-search') return 'unknown';
  let sawVerdict = false;
  let pending = false;
  for (const h of hosts) {
    if (h.status === 'loading') { pending = true; continue; }
    if (h.status === 'error') continue; // no verdict from a down host
    sawVerdict = true;
    if (state.kind === 'dir-browse') {
      if (h.exists) return 'valid';
      continue;
    }
    // segment: parent must exist and contain the exact child (strict compare —
    // completions fill exact casing, and remote hosts may be case-sensitive)
    if (!h.exists) continue;
    const parent = h.parent.endsWith('/') ? h.parent : h.parent + '/';
    const hit = h.dirs.some(p => {
      if (!p.startsWith(parent)) return false;
      const rest = p.slice(parent.length);
      return !rest.includes('/') && rest === state.partial;
    });
    if (hit) return 'valid';
  }
  if (pending) return 'unknown';
  return sawVerdict ? 'missing' : 'unknown';
}

/** Ghost-text suffix: non-null only when the top candidate's leaf strictly
 *  prefix-extends the typed partial (case-insensitive compare, original casing
 *  returned). E.g. typed '/a/b/wal', top '/a/b/walnut' → 'nut'. */
export function ghostSuffix(state: InputState, topCandidateCwd: string | null): string | null {
  if (!topCandidateCwd) return null;
  if (state.kind !== 'segment') return null;
  if (!state.partial) return null;
  const leaf = topCandidateCwd.slice(topCandidateCwd.lastIndexOf('/') + 1);
  if (leaf.length <= state.partial.length) return null;
  if (!leaf.toLowerCase().startsWith(state.partial.toLowerCase())) return null;
  return leaf.slice(state.partial.length);
}
