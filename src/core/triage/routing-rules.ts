/**
 * Inbox Triage's standing routing rules: "mail about X goes to task Y", kept across runs.
 *
 * Every triage run is a new task and a new session that completes (2026-11-05: "Triage · 21:38 ·
 * 2 items"), so a routing the user asked for in one run's chat was gone by the next. The rules live
 * here instead, in one file the runs never own: every batch reads them (batch.ts puts them, and the
 * items they match, in the run's first message), and `triage_route` hands an item to a rule's task
 * with the rule named on the message, so the receiving task (and the run's own record) says which
 * rule routed it.
 *
 * Who writes: a person (Settings > Inbox Triage), Main or a VP (ops `triage_rule_set` /
 * `triage_rule_delete`), checked where the route is served (routes/triage-rules-v1.ts). A rule is
 * matched by plain case-insensitive substrings, no model call: `from` against the sender (a mail's
 * name and address, a Slack message's author and conversation), `subject` against a mail's subject
 * or a Slack message's text; a rule with both needs both.
 *
 * File: `<WALNUT_HOME>/triage/routing-rules.json`, one writer at a time (withFileLock). Only a missing file reads as no rules; anything else that is not a valid table throws (readRulesFile).
 * Paths come from the caller, because the batch action is its own bundle (actions/inbox-triage-batch.ts).
 */
import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { writeJsonFile } from '../../utils/fs.js';
import { withFileLock } from '../../utils/file-lock.js';

export const ROUTING_RULES_FILE = path.join('triage', 'routing-rules.json');
export const MAX_ROUTING_RULES = 200;
const MATCH_MAX = 200;
const NOTE_MAX = 500;
/** How many routed items each rule remembers (the newest), for its line in Settings. */
const RECENT_ROUTES = 5;

/** Who wrote a rule, as the user reads it. */
export interface RoutingRuleAuthor {
  by: 'human' | 'task';
  taskId?: string;
  name?: string;
}

export interface RoutedItemNote {
  at: number;
  /** The item's subject (mail) or first words (Slack), as the run named it. */
  item: string;
  source?: 'mail' | 'slack';
}

export interface TriageRoutingRule {
  /** `rr-<base36 time>-<rand>` */
  id: string;
  match: { from?: string; subject?: string };
  /** The task the matched items go to. */
  taskId: string;
  /** The task's title when the rule was written or last read (the run and Settings show it). */
  taskTitle?: string;
  /** Why, in the writer's words; the run reads it. */
  note?: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  /** Who last wrote it (a toggle included). */
  author: RoutingRuleAuthor;
  /** Who added it; kept across every later change. Absent on a rule written before 2026-11-05: `author` then. */
  createdBy?: RoutingRuleAuthor;
  /** Routed items, newest first, at most RECENT_ROUTES. */
  recent?: RoutedItemNote[];
  routedCount?: number;
}

export interface RoutingRulesFile {
  version: 1;
  rules: TriageRoutingRule[];
}

export class RoutingRuleError extends Error {
  constructor(message: string, readonly code: string, readonly status = 400) { super(message); }
}

export function routingRulesPath(home: string): string {
  return path.join(home, ROUTING_RULES_FILE);
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

function normalizeRule(raw: unknown): TriageRoutingRule | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = text(r.id, 60);
  const taskId = text(r.taskId, 120);
  const m = (r.match && typeof r.match === 'object' ? r.match : {}) as Record<string, unknown>;
  const from = text(m.from, MATCH_MAX);
  const subject = text(m.subject, MATCH_MAX);
  // Any plain id is kept, so a hand-edited file loses no rule at the next write; new ones are `rr-…`.
  if (!/^[A-Za-z0-9][\w.-]{0,59}$/.test(id) || !taskId || (!from && !subject)) return null;
  const authorOf = (v: unknown): RoutingRuleAuthor => {
    const a = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
    return {
      by: a.by === 'task' ? 'task' : 'human',
      ...(text(a.taskId, 120) ? { taskId: text(a.taskId, 120) } : {}),
      ...(text(a.name, 200) ? { name: text(a.name, 200) } : {}),
    };
  };
  const recent = Array.isArray(r.recent)
    ? r.recent.flatMap((n): RoutedItemNote[] => {
      const o = (n && typeof n === 'object' ? n : {}) as Record<string, unknown>;
      const item = text(o.item, 200);
      if (!item || typeof o.at !== 'number') return [];
      return [{ at: o.at, item, ...(o.source === 'mail' || o.source === 'slack' ? { source: o.source } : {}) }];
    }).slice(0, RECENT_ROUTES)
    : [];
  return {
    id,
    match: { ...(from ? { from } : {}), ...(subject ? { subject } : {}) },
    taskId,
    ...(text(r.taskTitle, 200) ? { taskTitle: text(r.taskTitle, 200) } : {}),
    ...(text(r.note, NOTE_MAX) ? { note: text(r.note, NOTE_MAX) } : {}),
    enabled: r.enabled !== false,
    createdAt: typeof r.createdAt === 'number' ? r.createdAt : 0,
    updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : 0,
    author: authorOf(r.author),
    ...(r.createdBy && typeof r.createdBy === 'object' ? { createdBy: authorOf(r.createdBy) } : {}),
    ...(recent.length ? { recent } : {}),
    ...(typeof r.routedCount === 'number' && r.routedCount > 0 ? { routedCount: Math.floor(r.routedCount) } : {}),
  };
}

/** The rules file is there but is not a rules table Walnut can read: never taken for no rules. */
function unreadable(file: string, why: string): RoutingRuleError {
  return new RoutingRuleError(`The routing rules at ${file} cannot be read: ${why}. Nothing was changed; fix or remove the file.`, 'rules_unreadable', 503);
}

function parseRulesFile(file: string, content: string): RoutingRulesFile {
  if (!content.trim()) throw unreadable(file, 'the file is empty');
  let raw: unknown;
  try { raw = JSON.parse(content); } catch (err) { throw unreadable(file, `it is not JSON (${err instanceof Error ? err.message : String(err)})`); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw unreadable(file, 'it is not an object');
  const doc = raw as { version?: unknown; rules?: unknown };
  if (doc.version !== 1) throw unreadable(file, `its version is ${JSON.stringify(doc.version ?? null)}, not 1`);
  if (!Array.isArray(doc.rules)) throw unreadable(file, '`rules` is not a list');
  const rules = doc.rules.map((r, i) => {
    const rule = normalizeRule(r);
    if (!rule) throw unreadable(file, `rule ${i + 1} has no valid id, task or match`);
    return rule;
  });
  return { version: 1, rules };
}

// Only a missing file is no rules. A read that failed (EACCES, EMFILE, an I/O error), an empty
// file, a wrong version, `rules` not a list or a rule Walnut cannot read throws: read as "no
// rules" it would hand every item a rule covers to triage as unrouted mail, and a write that
// started from it would replace the whole table with an empty one.
async function readRulesFile(file: string): Promise<RoutingRulesFile> {
  let content: string;
  try {
    content = await fs.readFile(file, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return { version: 1, rules: [] };
    throw unreadable(file, err instanceof Error ? err.message : String(err));
  }
  return parseRulesFile(file, content);
}

export async function readRoutingRules(home: string): Promise<TriageRoutingRule[]> {
  return (await readRulesFile(routingRulesPath(home))).rules;
}

async function mutate<R>(home: string, fn: (file: RoutingRulesFile) => R): Promise<R> {
  const file = routingRulesPath(home);
  return withFileLock(file, async () => {
    const current = await readRulesFile(file);
    const out = fn(current);
    await writeJsonFile(file, current);
    return out;
  });
}

export interface RoutingRuleInput {
  from?: string;
  subject?: string;
  taskId?: string;
  taskTitle?: string;
  note?: string;
  enabled?: boolean;
  /** Where the rule goes in the list (0 = first). The first matching rule wins. */
  position?: number;
}

function newRuleId(): string {
  return `rr-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
}

/**
 * Create a rule (no `id`) or change one (`id`), returning it. A field left out of a change keeps
 * its value; `from: ""` clears that half, and a rule with neither half is refused.
 */
export async function setRoutingRule(
  home: string,
  input: RoutingRuleInput & { id?: string },
  author: RoutingRuleAuthor,
  now = Date.now(),
): Promise<TriageRoutingRule> {
  return mutate(home, (file) => {
    const existing = input.id ? file.rules.find((r) => r.id === input.id) : undefined;
    if (input.id && !existing) throw new RoutingRuleError(`No routing rule ${input.id}`, 'not_found', 404);
    const from = input.from !== undefined ? senderNeedle(text(input.from, MATCH_MAX)) : existing?.match.from ?? '';
    const subject = input.subject !== undefined ? text(input.subject, MATCH_MAX) : existing?.match.subject ?? '';
    if (!from && !subject) {
      throw new RoutingRuleError('A routing rule needs a sender or a subject to match (or both).', 'match_required');
    }
    const taskId = input.taskId !== undefined ? text(input.taskId, 120) : existing?.taskId ?? '';
    if (!taskId) throw new RoutingRuleError('A routing rule needs the task its items go to (task_id).', 'task_required');
    if (!existing && file.rules.length >= MAX_ROUTING_RULES) {
      throw new RoutingRuleError(`At most ${MAX_ROUTING_RULES} routing rules; remove one first.`, 'too_many', 409);
    }
    const same = file.rules.find((r) => r !== existing && r.taskId === taskId
      && sameNeedle(r.match.from, from) && sameNeedle(r.match.subject, subject));
    if (same) {
      throw new RoutingRuleError(`A rule already sends these items to that task: ${ruleMatchText(same)}${same.enabled ? '' : ' (turned off)'}.`, 'duplicate_rule', 409);
    }
    const note = input.note !== undefined ? text(input.note, NOTE_MAX) : existing?.note ?? '';
    const title = input.taskTitle !== undefined ? text(input.taskTitle, 200)
      : taskId === existing?.taskId ? existing?.taskTitle ?? '' : '';
    const rule: TriageRoutingRule = {
      id: existing?.id ?? newRuleId(),
      match: { ...(from ? { from } : {}), ...(subject ? { subject } : {}) },
      taskId,
      ...(title ? { taskTitle: title } : {}),
      ...(note ? { note } : {}),
      enabled: input.enabled ?? existing?.enabled ?? true,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      // Who last wrote it, and who added it, so Settings can say "Added by Walnut VP · changed by you".
      author,
      createdBy: existing ? existing.createdBy ?? existing.author : author,
      ...(existing?.recent ? { recent: existing.recent } : {}),
      ...(existing?.routedCount ? { routedCount: existing.routedCount } : {}),
    };
    if (existing) file.rules[file.rules.indexOf(existing)] = rule;
    else file.rules.push(rule);
    if (typeof input.position === 'number' && Number.isFinite(input.position)) {
      const at = Math.max(0, Math.min(file.rules.length - 1, Math.floor(input.position)));
      file.rules.splice(file.rules.indexOf(rule), 1);
      file.rules.splice(at, 0, rule);
    }
    return rule;
  });
}

export async function deleteRoutingRule(home: string, id: string): Promise<boolean> {
  return mutate(home, (file) => {
    const before = file.rules.length;
    file.rules = file.rules.filter((r) => r.id !== id);
    return file.rules.length !== before;
  });
}

/** Record one routed item on its rule (newest first). False when the rule is gone. */
export async function noteRoutedItem(home: string, id: string, note: RoutedItemNote): Promise<boolean> {
  return mutate(home, (file) => {
    const rule = file.rules.find((r) => r.id === id);
    if (!rule) return false;
    rule.recent = [{ ...note, item: text(note.item, 200) }, ...(rule.recent ?? [])].slice(0, RECENT_ROUTES);
    rule.routedCount = (rule.routedCount ?? 0) + 1;
    return true;
  });
}

// ── Matching (pure) ──

export interface RoutableItem {
  source: 'mail' | 'slack';
  /** A mail's sender (name and address), a Slack message's author and conversation. */
  from: string;
  /** A mail's subject, a Slack message's text. */
  subject: string;
}

function contains(haystack: string, needle: string): boolean {
  return haystack.toLocaleLowerCase().includes(needle.toLocaleLowerCase());
}

/** Whether one rule matches one item. A disabled rule matches nothing. */
export function ruleMatches(rule: TriageRoutingRule, item: RoutableItem): boolean {
  if (!rule.enabled) return false;
  const { from, subject } = rule.match;
  if (!from && !subject) return false;
  if (from && !contains(item.from, from)) return false;
  if (subject && !contains(item.subject, subject)) return false;
  return true;
}

/** The first enabled rule (in file order) matching an item, or undefined. */
export function firstMatchingRule(rules: readonly TriageRoutingRule[], item: RoutableItem): TriageRoutingRule | undefined {
  return rules.find((r) => ruleMatches(r, item));
}

function sameNeedle(a: string | undefined, b: string): boolean {
  return (a ?? '').toLocaleLowerCase() === b.toLocaleLowerCase();
}

/**
 * A pasted `Contractor Bob <bob@kitchenpros.example>` matches by its address: a sender's display
 * name varies from mail to mail, so the whole header would match almost nothing.
 */
export function senderNeedle(raw: string): string {
  const angle = /<([^<>\s]+@[^<>\s]+)>/.exec(raw);
  return (angle ? angle[1]! : raw).trim();
}

/** A rule as one line the run and the routed task read: `from contains "acme" and subject contains "offer"`. */
export function ruleMatchText(rule: Pick<TriageRoutingRule, 'match'>): string {
  const parts: string[] = [];
  if (rule.match.from) parts.push(`sender contains "${rule.match.from}"`);
  if (rule.match.subject) parts.push(`subject contains "${rule.match.subject}"`);
  return parts.join(' and ');
}
