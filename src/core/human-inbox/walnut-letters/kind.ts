/**
 * The shape every letter Walnut writes itself is declared in (registry.ts lists them). A kind says
 * once: what it is, who sends it, how its words read in each letter language, and how Walnut knows
 * the letter is no longer needed, so the sweep (sweep.ts) can settle it when the thing it asked or
 * told about is gone (2026-11-02: "Let ... use the Mac?" letters outlived the rule that made them).
 *
 * The user's own words, task titles, host names, ids and anything a model or another program wrote
 * go into a template as given: only Walnut's fixed words are translated.
 */
import type { LetterAction, LetterRecord, LetterType } from '../types.js';
import type { Task } from '../../types.js';
import type { LetterLang } from './languages.js';

export interface RenderedLetter {
  subject: string;
  markdown: string;
  text?: string;
  actions?: LetterAction[];
}

export interface StillNeededContext {
  lang: LetterLang;
  now: number;
  /** The task, read once per sweep; undefined when it is gone. */
  task: (id: string) => Promise<Task | undefined>;
}

/**
 * How Walnut knows a letter of this kind is no longer needed: `check` answers with the one line the
 * user reads when it settles the letter (in `ctx.lang`), or null to keep it. `none` says why the kind
 * has no check here: it archives itself elsewhere, or it is a report with nothing to settle.
 */
export type StillNeededRule =
  | { check: (letter: LetterRecord, ctx: StillNeededContext) => Promise<string | null> }
  | { none: string };

export interface WalnutLetterKind<P = never> {
  /** Stable id; also the `createdByOp` prefix (`<id>:`) of the letters that carry one. */
  id: string;
  type: LetterType;
  /** The source files that send it (repo-relative): the ratchet holds every send site to this list. */
  callers: readonly string[];
  /** New letters carry `createdByOp` = `<id>:...`. */
  marked: boolean;
  /** Letters sent before the mark existed (English, by subject shape), or sent without one. */
  matchesUnmarked?: (letter: LetterRecord) => boolean;
  render: (lang: LetterLang, params: P) => RenderedLetter;
  /** Params the ratchet renders every language with. */
  samples: readonly P[];
  stillNeeded: StillNeededRule;
}

/** Declare a kind (keeps its params type while the registry holds them all). */
export function letterKind<P>(kind: WalnutLetterKind<P>): WalnutLetterKind<P> {
  return kind;
}

/** The `createdByOp` a marked kind's letter is sent with. */
export function letterOpKey(kindId: string, ...parts: string[]): string {
  return [kindId, ...parts.map((p) => encodeURIComponent(p))].join(':');
}
