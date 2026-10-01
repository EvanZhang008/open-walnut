/**
 * What plain Enter does in the folder picker (enter-action.ts): every branch.
 * Pure function tests, no IO.
 */
import { describe, it, expect } from 'vitest';
import { enterAction, type EnterContext } from '../../../web/src/components/sessions/path-selector/enter-action';

const base: EnterContext = {
  editMode: true,
  validity: 'unknown',
  hasRows: false,
  manualNav: false,
  inputKind: 'dir-browse',
  hasCreateOption: false,
};
const at = (over: Partial<EnterContext>) => enterAction({ ...base, ...over });

describe('enterAction: browse mode (history search)', () => {
  it('opens the highlighted history row, or does nothing without one', () => {
    expect(at({ editMode: false, inputKind: 'browse', hasRows: true })).toBe('drill');
    expect(at({ editMode: false, inputKind: 'browse', hasRows: false })).toBe('none');
    // Validity never matters in browse mode: there is no path to confirm yet.
    expect(at({ editMode: false, inputKind: 'browse', hasRows: false, validity: 'valid' })).toBe('none');
  });
});

describe('enterAction: a row the user picked with arrow keys wins', () => {
  it('drills into it even when the typed folder exists or could be created', () => {
    expect(at({ hasRows: true, manualNav: true, validity: 'valid' })).toBe('drill');
    expect(at({ hasRows: true, manualNav: true, inputKind: 'segment', validity: 'missing', hasCreateOption: true })).toBe('drill');
  });

  it('a stale manual flag with no highlighted row falls through to the path rules', () => {
    expect(at({ hasRows: false, manualNav: true, validity: 'valid' })).toBe('confirm');
  });
});

describe('enterAction: the typed path is a folder', () => {
  it('a trailing-slash folder is used, not its first child', () => {
    // dir-browse highlights no row by default, so hasRows is false there...
    expect(at({ inputKind: 'dir-browse', validity: 'valid', hasRows: false })).toBe('confirm');
    // ...and a hovered row (hover is not manual navigation) does not take Enter over.
    expect(at({ inputKind: 'dir-browse', validity: 'valid', hasRows: true })).toBe('confirm');
  });

  it('a segment that names a folder exactly is used', () => {
    expect(at({ inputKind: 'segment', validity: 'valid', hasRows: true })).toBe('confirm');
    expect(at({ inputKind: 'segment', validity: 'valid', hasRows: false })).toBe('confirm');
  });

  it('an empty folder (no rows at all) is used', () => {
    expect(at({ inputKind: 'dir-browse', validity: 'valid', hasRows: false })).toBe('confirm');
  });
});

describe('enterAction: a partial segment being completed', () => {
  it('drills into the highlighted completion (today\'s behaviour)', () => {
    expect(at({ inputKind: 'segment', validity: 'missing', hasRows: true })).toBe('drill');
    // Even with the create row on offer: the highlighted match is what the user sees selected.
    expect(at({ inputKind: 'segment', validity: 'missing', hasRows: true, hasCreateOption: true })).toBe('drill');
    expect(at({ inputKind: 'segment', validity: 'unknown', hasRows: true })).toBe('drill');
  });

  it('a scoped keyword search drills into its highlighted match', () => {
    expect(at({ inputKind: 'scoped-search', hasRows: true })).toBe('drill');
    expect(at({ inputKind: 'scoped-search', hasRows: false })).toBe('none');
  });
});

describe('enterAction: nothing to pick', () => {
  it('a missing folder takes the create row when it is offered', () => {
    expect(at({ inputKind: 'segment', validity: 'missing', hasCreateOption: true })).toBe('create');
    expect(at({ inputKind: 'dir-browse', validity: 'missing', hasCreateOption: true })).toBe('create');
  });

  it('a missing folder with no single target host does nothing', () => {
    expect(at({ inputKind: 'segment', validity: 'missing', hasCreateOption: false })).toBe('none');
  });

  it('still listing (or a host that did not answer) does nothing', () => {
    expect(at({ inputKind: 'segment', validity: 'unknown' })).toBe('none');
    expect(at({ inputKind: 'dir-browse', validity: 'unknown', hasCreateOption: true })).toBe('none');
  });
});
