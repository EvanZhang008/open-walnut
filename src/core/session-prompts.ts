/**
 * The two session prompt texts, as record fields (the storage is session-db.ts's alone).
 *
 * A session row carries two large texts: the spawn prompt (`appliedAppendSystemPrompt`) and the
 * persona (`profile.systemPrompt`), 78% of the Mac's payload bytes (2026-11-25). They live in their
 * own rows of sessions.sqlite, and a record comes in two shapes:
 *
 *   - whole: the texts, never a stub. Every single-row read (getSessionByClaudeId, getSessionByLane)
 *     and every query that maps its own rows (rowToSession) returns this, as it always did.
 *   - stub: no text, a `...Ref` stub per text present (its size, hash, and for a persona whether it
 *     is blank). The session store cache and a writer's own read inside its transaction return this.
 *
 * A write changes a prompt only where its caller names it (promptChangesOf): a status update names
 * neither and never touches them. A profile that carries a stub and no text was built from a stub
 * record, so it keeps the stored persona instead of reading as a clear (the risk a whole-profile
 * update from a cached row would otherwise carry).
 */
import { createHash } from 'node:crypto';
import type { SessionProfile, SessionPromptRef, SessionRecord } from './types.js';

/** The two prompt texts of one session, each absent when it has none. */
export interface SessionPrompts {
  appliedAppendSystemPrompt?: string;
  systemPrompt?: string;
}

/** What a write does to each prompt: absent = keep the stored one, null = clear it, a string = set it. */
export interface PromptChanges {
  appliedAppendSystemPrompt?: string | null;
  systemPrompt?: string | null;
}

export const PROMPT_KEYS = ['appliedAppendSystemPrompt', 'systemPrompt'] as const;

/**
 * The store-format probe (`walnut --json store-formats`): this build reads a session row whose
 * prompts live outside its payload. A build before the split has no such command, so its probe
 * fails: the rollback check and the leader switch's preflight refuse it on such a file.
 */
export const SESSION_STORE_FORMATS = { sessionsPromptSplit: 1 } as const;

/** Payload tests for a text in SQL (the quote after the colon: a stub's `...Ref` key never matches). */
export const HAS_AASP_TEXT = `instr(payload, '"appliedAppendSystemPrompt":"') > 0`;
export const HAS_PERSONA_TEXT = `instr(payload, '"systemPrompt":"') > 0`;
/** Either text: one `instr` (both keys end in `ystemPrompt":"`; a scan's misses read the whole payload, so one, not two). */
export const HAS_PROMPT_TEXT = `instr(payload, 'ystemPrompt":"') > 0`;
/**
 * A row of the new shape: a stub whose text its payload does not hold and only the table has (only
 * a build from the split on reads it). A stub written beside its text (`inline`) is not one: its
 * text was cleared by a build before the split.
 */
const SPLIT_REF = (ref: string, text: string) =>
  `(instr(payload, '"${ref.split('.').pop()}"') > 0 AND NOT ${text} AND json_valid(payload) AND json_type(payload, '$.${ref}') = 'object' AND coalesce(json_extract(payload, '$.${ref}.inline'), 0) <> 1)`;
export const SPLIT_PROMPT_ROW = `(${SPLIT_REF('appliedAppendSystemPromptRef', HAS_AASP_TEXT)} OR ${SPLIT_REF('profile.systemPromptRef', HAS_PERSONA_TEXT)})`;
/** Does a sessions file hold any row of the new shape? (read only; the rollback check, the leader switch) */
export const SPLIT_PROMPT_ROWS_SQL = `SELECT count(*) AS n FROM sessions WHERE ${SPLIT_PROMPT_ROW}`;
export type PromptKey = typeof PROMPT_KEYS[number];

/**
 * What "blank" means for a persona, in JS and in SQL alike: only the characters String.prototype.trim
 * removes (ECMAScript WhiteSpace and LineTerminator). SQL's trim gets the same set (BLANK_CHARS_SQL),
 * so a stub the cache scan makes says what the whole record says.
 */
export const BLANK_CODE_POINTS: readonly number[] = [
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006,
  0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff,
];
const BLANK_SET = new Set(BLANK_CODE_POINTS);
export const BLANK_CHARS_SQL = `char(${BLANK_CODE_POINTS.join(', ')})`;

/** Is the text empty or only blank characters (BLANK_CODE_POINTS)? */
export function isBlankText(text: string): boolean {
  for (let i = 0; i < text.length; i++) if (!BLANK_SET.has(text.charCodeAt(i))) return false;
  return true;
}

/** A payload stub that stands for a text kept elsewhere (the table); an `inline` one without its text stands for none. */
export function standingRef(ref: unknown): SessionPromptRef | undefined {
  if (!ref || typeof ref !== 'object' || typeof (ref as SessionPromptRef).bytes !== 'number') return undefined;
  return (ref as SessionPromptRef).inline ? undefined : ref as SessionPromptRef;
}

/**
 * The `prompt_text_refs` column of a row (session-db.ts): the stub of each text its payload holds,
 * as JSON, `{}` for none. Written with the payload, so the cache scan reads the stubs from it
 * instead of measuring the texts; a build before the split leaves it NULL (it does not know it).
 */
export function textRefsColumnOf(prompts: SessionPrompts, hasProfile: boolean): string {
  const out: Record<string, SessionPromptRef> = {};
  if (prompts.appliedAppendSystemPrompt !== undefined) out.appliedAppendSystemPrompt = promptRefOf(prompts.appliedAppendSystemPrompt, false, false);
  if (prompts.systemPrompt !== undefined && hasProfile) out.systemPrompt = promptRefOf(prompts.systemPrompt, true, false);
  return JSON.stringify(out);
}

/** The stubs a `prompt_text_refs` column holds (unreadable: none). */
export function textRefsOf(column: unknown): { appliedAppendSystemPrompt?: SessionPromptRef; systemPrompt?: SessionPromptRef } {
  if (typeof column !== 'string' || column === '' || column === '{}') return {};
  try {
    const o = JSON.parse(column) as Record<string, unknown>;
    const pick = (v: unknown) => (v && typeof v === 'object' && typeof (v as SessionPromptRef).bytes === 'number' ? v as SessionPromptRef : undefined);
    const a = pick(o.appliedAppendSystemPrompt);
    const p = pick(o.systemPrompt);
    return { ...(a ? { appliedAppendSystemPrompt: a } : {}), ...(p ? { systemPrompt: p } : {}) };
  } catch { return {}; }
}

export function promptSha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * The stub of one text; a persona's also says whether it is blank (isRouterAreaSession asks).
 * `sha: false` for a stub that sits beside its text (a payload that still holds it): such a stub
 * is never trusted over the text, so it needs no hash, and a write does not pay one (sha256 of a
 * 20 to 60 KB text, twice per status write).
 */
export function promptRefOf(text: string, persona: boolean, sha = true): SessionPromptRef {
  return { ...(sha ? { sha256: promptSha256(text) } : {}), bytes: Buffer.byteLength(text, 'utf8'), ...(persona ? { blank: isBlankText(text) } : {}) };
}

/** Does the record have a non-blank persona, from its text or its stub? */
export function hasPersona(profile: Pick<SessionProfile, 'systemPrompt' | 'systemPromptRef'> | undefined | null): boolean {
  if (!profile) return false;
  if (typeof profile.systemPrompt === 'string') return !isBlankText(profile.systemPrompt);
  return profile.systemPromptRef?.blank === false;
}

/** Does the record have a non-empty spawn prompt, from its text or its stub? */
export function hasSpawnPrompt(record: Pick<SessionRecord, 'appliedAppendSystemPrompt' | 'appliedAppendSystemPromptRef'>): boolean {
  if (typeof record.appliedAppendSystemPrompt === 'string') return record.appliedAppendSystemPrompt !== '';
  return (record.appliedAppendSystemPromptRef?.bytes ?? 0) > 0;
}

/**
 * The prompt changes a patch names. `whole`: the patch is a whole row (a host's born row or rows
 * frame), so a prompt it leaves out is cleared, as every other field it leaves out is. `keep`:
 * fields the patch holds only cut (fact-log.ts cutRowFields), whose stored value stays.
 */
export function promptChangesOf(patch: Readonly<Record<string, unknown>>, opts: { whole?: boolean; keep?: readonly string[] } = {}): PromptChanges {
  const out: PromptChanges = {};
  const keep = opts.keep ?? [];
  if (!keep.includes('appliedAppendSystemPrompt')) {
    if ('appliedAppendSystemPrompt' in patch) {
      const v = patch.appliedAppendSystemPrompt;
      // Named with no text (undefined, or null on the channel's wire): a clear (router/simplify-migration.ts).
      out.appliedAppendSystemPrompt = typeof v === 'string' ? v : null;
    // A whole row in the stub shape (a stub, no text) was read without its texts: they stay.
    // An inline stub with no text is a text an older build cleared (standingRef): cleared here too.
    } else if (opts.whole && !standingRef(patch.appliedAppendSystemPromptRef)) out.appliedAppendSystemPrompt = null;
  }
  if (!keep.includes('profile')) {
    if ('profile' in patch) {
      const p = patch.profile as SessionProfile | null | undefined;
      if (!p || typeof p !== 'object') out.systemPrompt = null;
      else if (typeof p.systemPrompt === 'string') out.systemPrompt = p.systemPrompt;
      // A profile with a stub and no text was built from a stub record: its persona stays.
      else if (!standingRef(p.systemPromptRef)) out.systemPrompt = null;
    } else if (opts.whole) out.systemPrompt = null;
  }
  return out;
}

/** True when `changes` names neither prompt. */
export function noPromptChange(changes: PromptChanges): boolean {
  return changes.appliedAppendSystemPrompt === undefined && changes.systemPrompt === undefined;
}

/** The prompts `changes` sets over `stored` (a clear drops one). */
export function applyPromptChanges(stored: SessionPrompts, changes: PromptChanges): SessionPrompts {
  const out: SessionPrompts = {};
  for (const k of PROMPT_KEYS) {
    const c = changes[k];
    const v = c === undefined ? stored[k] : c === null ? undefined : c;
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** The changes that set exactly `prompts` (a rename's or a copy's carry from another row). */
export function promptChangesSetting(prompts: SessionPrompts): PromptChanges {
  return { appliedAppendSystemPrompt: prompts.appliedAppendSystemPrompt ?? null, systemPrompt: prompts.systemPrompt ?? null };
}

/** The record's texts, as it holds them (a stub record holds none). */
export function promptsOf(record: Pick<SessionRecord, 'appliedAppendSystemPrompt' | 'profile'>): SessionPrompts {
  const out: SessionPrompts = {};
  if (typeof record.appliedAppendSystemPrompt === 'string') out.appliedAppendSystemPrompt = record.appliedAppendSystemPrompt;
  if (typeof record.profile?.systemPrompt === 'string') out.systemPrompt = record.profile.systemPrompt;
  return out;
}

/** The record without either text or stub: the part of it the row stores in its payload columns. */
export function withoutPrompts<T extends Partial<SessionRecord>>(record: T): T {
  const hasProfileKeys = !!record.profile && ('systemPrompt' in record.profile || 'systemPromptRef' in record.profile);
  // A copy even when there is nothing to take out: callers set stubs or texts on what this returns.
  if (!('appliedAppendSystemPrompt' in record) && !('appliedAppendSystemPromptRef' in record) && !hasProfileKeys) return { ...record };
  const out = { ...record };
  delete out.appliedAppendSystemPrompt;
  delete out.appliedAppendSystemPromptRef;
  if (hasProfileKeys) {
    const { systemPrompt: _text, systemPromptRef: _ref, ...rest } = record.profile!;
    out.profile = rest;
  }
  return out;
}

/** The stub record: no text, a stub per text `prompts` holds (none for a persona without a profile). */
export function withPromptStubs<T extends Partial<SessionRecord>>(
  record: T, prompts: SessionPrompts, refs?: { appliedAppendSystemPrompt?: SessionPromptRef; systemPrompt?: SessionPromptRef },
  sha = true, inline = false,
): T {
  const out = withoutPrompts(record);
  const own = (text: string, persona: boolean): SessionPromptRef => ({ ...promptRefOf(text, persona, sha), ...(inline ? { inline: true as const } : {}) });
  const aasp = refs?.appliedAppendSystemPrompt ?? (prompts.appliedAppendSystemPrompt !== undefined ? own(prompts.appliedAppendSystemPrompt, false) : undefined);
  const persona = refs?.systemPrompt ?? (prompts.systemPrompt !== undefined ? own(prompts.systemPrompt, true) : undefined);
  if (aasp) (out as Partial<SessionRecord>).appliedAppendSystemPromptRef = aasp;
  if (persona && out.profile) out.profile = { ...out.profile, systemPromptRef: persona };
  return out;
}

/** The whole record: the texts `prompts` holds and no stub (a persona needs a profile to sit in). */
export function withPromptTexts<T extends Partial<SessionRecord>>(record: T, prompts: SessionPrompts): T {
  const out = withoutPrompts(record);
  if (prompts.appliedAppendSystemPrompt !== undefined) (out as Partial<SessionRecord>).appliedAppendSystemPrompt = prompts.appliedAppendSystemPrompt;
  if (prompts.systemPrompt !== undefined && out.profile) out.profile = { ...out.profile, systemPrompt: prompts.systemPrompt };
  return out;
}

/**
 * The record as its stub, for comparing two records (a no-op guard, the area rule's profile
 * check): a text and the stub of the same text compare equal. A stub with no hash (the cache
 * scan's of an older row) is never needed here: writers read their row themselves.
 */
export function promptStubOf<T extends Partial<SessionRecord>>(record: T): T {
  const has = typeof record.appliedAppendSystemPrompt === 'string' || typeof record.profile?.systemPrompt === 'string';
  if (!has) return record;
  const out: Partial<SessionRecord> = { ...record };
  if (typeof record.appliedAppendSystemPrompt === 'string') {
    out.appliedAppendSystemPromptRef = promptRefOf(record.appliedAppendSystemPrompt, false);
    delete out.appliedAppendSystemPrompt;
  }
  if (typeof record.profile?.systemPrompt === 'string') {
    const { systemPrompt, ...rest } = record.profile;
    out.profile = { ...rest, systemPromptRef: promptRefOf(systemPrompt, true) };
  }
  return out as T;
}
