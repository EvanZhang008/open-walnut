/**
 * Copy and path helpers for the engine settings popover (and anything else that
 * names an engine's settings for one session). Pure: every sentence a person
 * reads about WHERE a save lands and WHEN it applies is built here, once, so the
 * subtitle, the aria-label, the scope note and the footer never disagree.
 *
 * Two rules the sentences keep: plain words (no engine-specific constant tables;
 * file names come from the view), and never the literal path of a repo's exclude
 * list (under a worktree or submodule the real file is elsewhere).
 */
import type {
  EngineSettingAppliesOn,
  EngineSettingView,
  EngineSettingsFileView,
  EngineSettingsGroupView,
  EngineSettingsView,
  EngineSettingsWriteResult,
  EngineSettingsWriteScope,
} from '@/api/engine-settings';
import { LOCAL_HOST } from '@/api/engine-settings';

const ELLIPSIS = '…';

/**
 * A working directory short enough for a subtitle. Starts from the first
 * two segments, one `…` segment and the last segment, then gives the budget
 * back one segment at a time, head first, then tail, until nothing more fits:
 * users with several sessions tell repos apart by the segment after `~/work/`,
 * so `~/work/repo-a/services/api` and `~/work/repo-b/services/api` must not
 * collapse into the same tail. Real session cwds are absolute, and their first
 * two segments are usually `/Users/<name>`, which names nobody's repo; filling
 * from both ends keeps the repo segment for those too (`/Users/x/work/repo-a/…/api`),
 * and a path whose head is one long opaque segment (a temp dir) keeps its
 * meaningful tail instead (`/var/folders/…/repo-a/services/api`). Still too
 * long after that: the tail is trimmed. Never guesses the home directory: a
 * `~/`-relative input stays relative, an absolute one is not tildified.
 */
export function shortenCwd(cwd: string, max = 48): string {
  if (cwd.length <= max) return cwd;
  const root = cwd.startsWith('~/') ? '~/' : cwd.startsWith('/') ? '/' : '';
  const segments = cwd.slice(root.length).split('/').filter(Boolean);
  let short = cwd;
  if (segments.length > 3) {
    let head = 2;
    let tail = 1;
    const render = (h: number, t: number) =>
      `${root}${segments.slice(0, h).join('/')}/${ELLIPSIS}/${segments.slice(segments.length - t).join('/')}`;
    // Grow while a whole segment still fits and the two halves stay apart.
    for (;;) {
      if (head + tail + 1 < segments.length && render(head + 1, tail).length <= max) { head += 1; continue; }
      if (head + tail + 1 < segments.length && render(head, tail + 1).length <= max) { tail += 1; continue; }
      break;
    }
    short = render(head, tail);
  }
  if (short.length > max) short = `${short.slice(0, Math.max(1, max - 1))}${ELLIPSIS}`;
  return short;
}

/**
 * A shortened cwd split for a subtitle that must never lose the repo:
 * `head` is everything up to and including the last slash and may be clipped
 * with an ellipsis by CSS; `tail` is the last segment, which never shrinks.
 * `/var/…/projects/repo-a` -> `{ head: '/var/…/projects/', tail: 'repo-a' }`.
 * A path with no slash (or one that is only a root) is all tail.
 */
export function splitCwdShort(cwdShort: string): { head: string; tail: string } {
  const at = cwdShort.lastIndexOf('/');
  if (at < 0) return { head: '', tail: cwdShort };
  const tail = cwdShort.slice(at + 1);
  if (!tail) return { head: '', tail: cwdShort };
  return { head: cwdShort.slice(0, at + 1), tail };
}

/**
 * First line of the "About these settings" panel: which file the
 * switch's CURRENT position writes, so the engine's own note under it (which
 * may talk about its default file) can never contradict the switch.
 */
export function aboutScopeLine(
  scope: EngineSettingsWriteScope,
  displayName: string,
  host: string,
  cwdShort: string,
  files: readonly EngineSettingsFileView[],
  cwd: string | undefined,
): string {
  if (scope === 'project') {
    const file = projectFileShort(files, cwd, cwdShort) ?? "this project's local settings file";
    return `With the switch on "This project only", every save from here goes to ${file}, created on first save and kept out of git. Other projects are unchanged.`;
  }
  const user = files.find((f) => f.scope === 'user' && !f.readOnly);
  const where = user ? `${user.path} on ${host}` : `your user settings on ${host}`;
  return `With the switch on "Same as ${displayName}", saves go to ${where}, except the few keys ${displayName} itself keeps per project; those go to this project's local file.`;
}

/**
 * `__local__` (and no host at all) is this machine; any other host reads as its
 * alias. ONE rule for every sentence, mid-sentence included: the label is a
 * name, like a host alias, so it keeps its capital ("on This Mac", "on devbox").
 * The subtitle, the menu tooltip, the aria-label, the scope note and the footer
 * used to disagree on the case; they all read this function verbatim now.
 */
export function hostLabel(host: string | undefined): string {
  return !host || host === LOCAL_HOST ? 'This Mac' : host;
}

/** "for sessions in <cwd>" or, for a session without a working directory, just "for sessions". */
function sessionsClause(cwdShort: string, kind: 'sessions' | 'new sessions'): string {
  return cwdShort ? `for ${kind} in ${cwdShort}` : `for ${kind}`;
}

/** Tooltip of the "+" menu row. */
export function menuActionTitle(displayName: string, cwdShort: string, host: string): string {
  return `${displayName} settings ${sessionsClause(cwdShort, 'sessions')} on ${host}`;
}

/** `aria-label` of the popover: what these settings are for, in one line. */
export function dialogAriaLabel(
  displayName: string,
  cwdShort: string,
  host: string,
  appliesOn: EngineSettingAppliesOn | undefined,
): string {
  if (appliesOn === 'new-session') return `${displayName} settings ${sessionsClause(cwdShort, 'new sessions')}`;
  return `${displayName} settings ${sessionsClause(cwdShort, 'sessions')} on ${host}`;
}

/**
 * The writable project file as it reads under the shortened cwd
 * (`~/work/repo/…/api/.claude/settings.local.json`). Undefined when the engine
 * declares no such file.
 */
export function projectFileShort(
  files: readonly EngineSettingsFileView[],
  cwd: string | undefined,
  cwdShort: string,
): string | undefined {
  const file = files.find((f) => f.scope === 'project' && !f.readOnly);
  return file ? shortenUnderCwd(file.path, cwd, cwdShort) : undefined;
}

/**
 * The writable project file relative to the working directory
 * (`.claude/settings.local.json`): the scope note names the file this way
 * because the header right above it already shows the directory in full.
 * A path not under the cwd (or no cwd) stays as the server sent it.
 */
export function projectFileRelative(
  files: readonly EngineSettingsFileView[],
  cwd: string | undefined,
): string | undefined {
  const file = files.find((f) => f.scope === 'project' && !f.readOnly);
  if (!file) return undefined;
  const base = cwd?.replace(/\/+$/, '');
  if (base && file.path.startsWith(`${base}/`)) return file.path.slice(base.length + 1);
  return file.path;
}

/** A path under the cwd, with the cwd prefix replaced by its short form; other paths unchanged. */
export function shortenUnderCwd(path: string, cwd: string | undefined, cwdShort: string): string {
  if (cwd && (path === cwd || path.startsWith(`${cwd.replace(/\/+$/, '')}/`))) {
    return `${cwdShort}${path.slice(cwd.replace(/\/+$/, '').length)}`;
  }
  if (!path.startsWith('/') && !path.startsWith('~')) return `${cwdShort}/${path}`;
  return path;
}

/**
 * What the picked scope means, in ONE short line (the fine print, created on
 * first save, the per-project exception under the default scope, lives in the
 * About overlay). The project file comes in relative to the working directory
 * (`projectFileRelative`), because the header right above already shows the
 * directory; the fallback names no path, because the client knows no engine's
 * layout.
 */
export function scopeSentence(
  scope: EngineSettingsWriteScope,
  displayName: string,
  host: string,
  projectFile?: string,
): string {
  if (scope === 'project') {
    const file = projectFile ?? 'its local settings file';
    return `Saves to ${file} in this project · not tracked by git.`;
  }
  return `Saves to your user settings on ${host}, as ${displayName} itself would.`;
}

/** When a saved value is felt, said once under the scope switch, in one line. */
export function appliesOnSentence(appliesOn: EngineSettingAppliesOn | undefined, displayName: string): string | null {
  if (appliesOn === 'next-turn') return "Applies on this session's next turn.";
  if (appliesOn === 'new-session') return `Applies to new ${displayName} sessions; this session keeps its current settings.`;
  return null;
}

/** The rows cannot say when a variable overrides the file on a host whose environment was not visible. */
export function envUncheckedSentence(host: string): string {
  return `Environment variables on ${host} were not checked: one set for the engine's processes there can take precedence over these files.`;
}

/** Why the "This project only" side is unavailable. */
export function scopeUnavailableReason(view: Pick<EngineSettingsView, 'cwd' | 'displayName'>): string {
  if (!view.cwd) return 'This session has no working directory, so there is no project file to write.';
  return `${view.displayName} keeps no per-project settings file.`;
}

export type EngineSettingsWriteOp = 'set' | 'unset';

export interface SavedSentenceInput {
  result: EngineSettingsWriteResult;
  scope: EngineSettingsWriteScope;
  hostLabel: string;
  cwdShort: string;
  files: readonly EngineSettingsFileView[];
  /** The key that was written; defaults to the first of `result.changed`. */
  key?: string;
  /** The session's working directory; defaults to `result.cwd`. */
  cwd?: string;
  /** What the write did: a Reset (`unset`) took the key OUT of the file, so "Saved to" would be a lie. */
  op?: EngineSettingsWriteOp;
}

/** Where the value in force comes from now that the key is gone from the write target. */
function fallbackSource(item: EngineSettingView | undefined, files: readonly EngineSettingsFileView[]): string {
  if (!item) return 'the value below';
  const label = (id: string | undefined) => files.find((f) => f.id === id)?.label ?? id ?? 'another file';
  if (item.source === 'file') return `the ${label(item.file)} value`;
  if (item.source === 'overlay') return `the ${label(item.overlay?.file)} value`;
  if (item.source === 'legacy') return item.legacy?.path ? `the value from ${item.legacy.path} (older location)` : 'the value from an older location';
  return item.defaultLabel && item.value === null ? `the default (${item.defaultLabel})` : 'the default';
}

/**
 * The footer sentence after a Reset landed: what was removed, from which file,
 * and which layer's value the session reads again.
 */
export function removedSentence(input: SavedSentenceInput): string {
  const { result, files } = input;
  const key = input.key ?? result.changed[0];
  const item = itemByKey(result, key);
  const target = item?.writeTarget.file;
  const file = target ? files.find((f) => f.id === target) : undefined;
  const what = item?.label ?? key ?? 'the key';
  const from = file?.label ?? (input.scope === 'project' ? 'this project (local)' : 'user settings');
  return `Removed ${what} from ${from}; ${fallbackSource(item, files)} applies again.`;
}

function itemByKey(result: EngineSettingsView, key: string | undefined): EngineSettingView | undefined {
  if (!key) return undefined;
  for (const group of result.groups) {
    const hit = group.items.find((i) => i.key === key);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * The footer sentence after a save landed (spec 6.6, six cases). It names the
 * file by its label and the directory by its short form, and describes the
 * repo's exclude list in words rather than by path.
 */
export function savedSentence(input: SavedSentenceInput): string {
  if (input.op === 'unset') return removedSentence(input);
  const { result, scope, hostLabel: host, cwdShort, files } = input;
  const key = input.key ?? result.changed[0];
  const target = itemByKey(result, key)?.writeTarget.file;
  const file = target ? files.find((f) => f.id === target) : undefined;
  if (scope === 'default' && (!file || file.scope === 'user')) return `Saved to user settings on ${host} (all projects).`;
  const label = file?.scope === 'project' ? file.label : 'this project (local)';
  const base = `Saved to ${label}, ${cwdShort} only.`;
  // The created-file and git answer rides with EVERY write that created a
  // project file, whatever the switch said; under the default scope the engine
  // itself files some keys per project, and the user still got a new file.
  const ex = result.gitExclude;
  if (!ex) return base;
  const created = shortenUnderCwd(ex.path, input.cwd ?? result.cwd, cwdShort);
  switch (ex.outcome) {
    case 'added': return `${base} Created ${created} and kept it out of git (this repo's exclude list).`;
    case 'already': return `${base} Created ${created}; git already ignores it.`;
    case 'not-a-repo': return `${base} Created ${created}; this directory is not a git checkout.`;
    case 'unavailable': return `${base} Created ${created} but could not update this repo's exclude list on this host; add it by hand.`;
    case 'failed': return `${base} Created ${created} but could not update this repo's exclude list: ${ex.error ?? 'no reason was given.'}`;
    default: return `${base} Created ${created}.`;
  }
}

/** The footer link's text before any view has answered: neutral, never a count it does not know. */
export const SETTINGS_ENGINES_LINK = 'Settings › Engines';

/**
 * The footer link to the groups the popover does not show, built from the
 * response: the group titles in response order joined with " and ",
 * then the real row count ("Updates and Terminal only settings (34) are in
 * Settings › Engines"). No group with rows: a plain link. No view yet (`null`):
 * the neutral text, so the link does not flip from a different sentence when
 * the view lands.
 */
export function otherGroupsLink(groups: readonly EngineSettingsGroupView[] | null): string {
  if (groups === null) return SETTINGS_ENGINES_LINK;
  const others = groups.filter((g) => g.id !== 'sessions' && g.items.length > 0);
  if (others.length === 0) return `Open ${SETTINGS_ENGINES_LINK}`;
  const count = others.reduce((n, g) => n + g.items.length, 0);
  return `${others.map((g) => g.title).join(' and ')} settings (${count}) are in ${SETTINGS_ENGINES_LINK}`;
}

export interface FilteredSettingRows {
  items: EngineSettingView[];
  /** `key` -> [start, end) ranges inside `item.help` to mark; only set when the row matched by help alone. */
  helpMarks: Map<string, Array<[number, number]>>;
}

/** Every case-insensitive occurrence of `needle` in `text`, as [start, end) ranges. */
function occurrences(text: string, needle: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const hay = text.toLowerCase();
  let from = 0;
  for (;;) {
    const at = hay.indexOf(needle, from);
    if (at < 0) return ranges;
    ranges.push([at, at + needle.length]);
    from = at + Math.max(1, needle.length);
  }
}

/**
 * Filter rows by a typed query. A hit on the label or key wins and the
 * list shows only those rows; only when nothing matches that way does the help
 * text count, and then the matched help fragments are returned so the UI can
 * mark why a row is in the result. Order is never changed.
 */
export function filterSettingRows(items: readonly EngineSettingView[], query: string): FilteredSettingRows {
  const q = query.trim().toLowerCase();
  const helpMarks = new Map<string, Array<[number, number]>>();
  if (!q) return { items: [...items], helpMarks };
  const byName = items.filter((i) => i.label.toLowerCase().includes(q) || i.key.toLowerCase().includes(q));
  if (byName.length > 0) return { items: byName, helpMarks };
  const byHelp = items.filter((i) => {
    const ranges = occurrences(i.help, q);
    if (ranges.length === 0) return false;
    helpMarks.set(i.key, ranges);
    return true;
  });
  return { items: byHelp, helpMarks };
}

/** The sessions group came back empty: say so, and where the rest lives. */
export function emptySentence(displayName: string): string {
  return `${displayName} reports no settings that a running session reads. Its other settings are in Settings › Engines.`;
}

export function noMatchSentence(query: string): string {
  return `No setting matches "${query}".`;
}

/**
 * localStorage key remembering the scope picked for one host + working
 * directory. With an `engine` the key is per engine too: a memory is
 * only ever written after THAT engine's view said the project layer exists, so
 * the next open can ask for the remembered scope on its FIRST request without
 * a Codex session in the same directory inheriting a Claude Code memory and
 * getting a 400 for a project file Codex does not keep.
 */
export function scopeStorageKey(host: string, cwd: string, engine?: string): string {
  return engine
    ? `walnut:engine-settings-scope:${engine}:${host}:${cwd}`
    : `walnut:engine-settings-scope:${host}:${cwd}`;
}
