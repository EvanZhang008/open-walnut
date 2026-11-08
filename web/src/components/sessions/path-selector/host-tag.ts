/**
 * The host tag on a folder row (PathList): the host's whole name, cut by CSS with an
 * ellipsis only when the row has no room (globals.css `.sps-path-host-tag`), and its
 * tooltip always naming the host in full. 2026-11-10 review: the tag cut the name to
 * its first 10 characters in code ("demo-devbo") with no way to read the rest.
 * Pure: tests/web/host-tag.test.ts.
 */

/** The tag's tooltip: the full host name, then what its status dot says when that adds anything. */
export function hostTagTitle(hostLabel: string, dotTitle?: string): string {
  const dot = dotTitle?.trim();
  if (!dot || dot === hostLabel) return hostLabel;
  return dot.startsWith(hostLabel) ? dot : `${hostLabel}: ${dot}`;
}
