/**
 * What plain Enter does in the folder picker (⇧Enter / ⌘Enter always confirm).
 *
 * A fresh install showed the gap: a user typed a folder that exists (or one to
 * create) and pressed Enter, and nothing happened because there was no row to
 * drill into. Only ⇧Enter or the small status button worked. Enter now means
 * "select or use path":
 *
 *   drill    a row is highlighted by ↑↓, or the typed segment is still a partial
 *            being completed (the highlighted row is the completion). Same as before.
 *   confirm  the typed path is itself an existing folder (a trailing-slash folder,
 *            or a segment that names a folder exactly). A dir-browse listing does not
 *            highlight its first child by default, so nothing on screen says Enter
 *            would open that child instead.
 *   create   no row to take, the path is missing and the create row is offered.
 *   none     still listing, or no verdict (a host that did not answer).
 *
 * Pure: no React, no IO. Unit-tested in tests/web/path-selector/enter-action.test.ts.
 */
import type { InputState } from './input-model';

export type EnterAction = 'drill' | 'confirm' | 'create' | 'none';

export interface EnterContext {
  /** The input holds a path (edit mode), not a history search. */
  editMode: boolean;
  /** pathValidity of the typed path. */
  validity: 'valid' | 'missing' | 'unknown';
  /** A candidate row exists AND one is highlighted (dir-browse starts with none). */
  hasRows: boolean;
  /** The user moved the highlight with ↑↓ since the input last changed. */
  manualNav: boolean;
  inputKind: InputState['kind'];
  /** The "Create folder … & start session in it" row is offered (single target host). */
  hasCreateOption: boolean;
}

export function enterAction(c: EnterContext): EnterAction {
  if (!c.editMode) return c.hasRows ? 'drill' : 'none';
  if (c.hasRows && c.manualNav) return 'drill';
  const pathKind = c.inputKind === 'dir-browse' || c.inputKind === 'segment';
  if (pathKind && c.validity === 'valid') return 'confirm';
  // A partial segment (or a scoped search) with matches: the highlighted row is the completion.
  if (c.hasRows) return 'drill';
  if (pathKind && c.validity === 'missing' && c.hasCreateOption) return 'create';
  return 'none';
}
