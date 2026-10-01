/**
 * The correction card's rules, as plain functions: which destinations step 1 offers, which name a new
 * group may take, how step 2 orders and pre-selects the drafts, and what `Save rule` writes.
 *
 * Kept free of React and of the network so every sentence and every default can be graded in the node
 * tier (`tests/web/mail-correct-model.test.ts`). Two rules it encodes, both from the spec (section 11):
 *
 * - A SELECTION IS NOT A REQUEST. The default pick is the first draft, but never one that moves more
 *   mail than the plain sender draft (a model draft that is too wide falls to the next item), and once
 *   the person touched the radios nothing here moves the pick again.
 * - WORDS COME FROM THE SERVER. Draft summaries, counts and the recipients numbers are the server's;
 *   this file only arranges them into the fixed sentences.
 */
import type {
  MailCatalogItem,
  MailDraftKind,
  MailProposeResponse,
  MailRule,
  MailRuleView,
  MailRuleWhen,
  MailSample,
  MailShadow,
} from '@/api/mail-groups';

export const IMPORTANT_ID = 'important';
export const IMPORTANT_LABEL = 'Important';
/** A rule's "not important, let Walnut pick the group". Only offered for mail in Important. */
export const NOT_IMPORTANT_ID = 'not-important';
export const NOT_IMPORTANT_LABEL = 'Not important';
/** The radio value of `New group…`. Not a group id: ids never start with an underscore. */
export const NEW_GROUP_VALUE = '__new-group__';
export const MAX_NOTE = 300;
/** The counter under `Why?` appears only past this many characters. */
export const NOTE_COUNTER_FROM = 250;
export const MAX_GROUP_NAME = 40;
/** A `moves` number above this is drawn bold: a correction about to move a lot of mail. */
export const BOLD_MOVES_OVER = 50;

export const COPY = {
  step2Title: 'Save this as a rule?',
  whyLabel: 'Why? (optional, helps Walnut learn)',
  whyPlaceholder: 'For example: these are pages I read in the pager',
  newGroupLabel: 'New group…',
  newGroupAria: 'New group name',
  groupExists: 'That group already exists.',
  reading: 'Reading your note…',
  modelFailed: "Walnut couldn't turn your note into a rule. Your note is saved with the rule you pick.",
  recipientsUnknown: "Walnut can't see who this mail was sent to, so it can't learn a rule about recipients from it.",
  fromNote: 'from your note',
  keepEarlier: 'Keep my earlier rule first',
  earlierStays: 'Your earlier rule stays first.',
  changedOnDisk: 'The rules file changed on disk. Reload to see the new version.',
} as const;

// ── step 1: where ──

export interface CorrectChoice {
  /** The radio value: a group id, or NEW_GROUP_VALUE. */
  value: string;
  /** What the radio says. */
  label: string;
  /** The name a rule's `then` carries for this choice. */
  target: string;
  keep: boolean;
}

/** The label of the group a mail is in now (`fallback` for a group the catalog does not list). */
export function groupLabelOf(catalog: readonly MailCatalogItem[], groupId: string, fallback?: string): string {
  if (groupId === IMPORTANT_ID) return IMPORTANT_LABEL;
  if (groupId === NOT_IMPORTANT_ID) return NOT_IMPORTANT_LABEL;
  return catalog.find((one) => one.id === groupId)?.label ?? fallback ?? groupId.replace(/^[us]:/, '');
}

export function whereSentence(currentLabel: string): string {
  return `This mail is in ${currentLabel}. Where should it go?`;
}

/**
 * Important; `Not important` for mail in Important (Walnut then picks its group); then every group
 * that holds unread mail or that a rule names. The current one reads `Keep in <name>`, and a group
 * the catalog does not list (a sender's own group) still gets its keep option.
 */
export function correctChoices(
  catalog: readonly MailCatalogItem[],
  currentGroupId: string,
  currentLabel?: string,
): CorrectChoice[] {
  const groups = catalog.filter((one) => one.id !== IMPORTANT_ID && one.id !== NOT_IMPORTANT_ID);
  const all: Array<{ id: string; label: string }> = [
    { id: IMPORTANT_ID, label: IMPORTANT_LABEL },
    ...(currentGroupId === IMPORTANT_ID ? [{ id: NOT_IMPORTANT_ID, label: NOT_IMPORTANT_LABEL }] : []),
    ...(currentGroupId !== IMPORTANT_ID && !groups.some((one) => one.id === currentGroupId)
      ? [{ id: currentGroupId, label: groupLabelOf(catalog, currentGroupId, currentLabel) }]
      : []),
    ...groups,
  ];
  return all.map((one) => {
    const keep = one.id === currentGroupId;
    return { value: one.id, label: keep ? `Keep in ${one.label}` : one.label, target: one.label, keep };
  });
}

/** Where focus lands when the card opens: the preset, else the first option that is not the current group. */
export function initialFocusIndex(choices: readonly CorrectChoice[], preset?: string | null): number {
  const wanted = preset ? choices.findIndex((one) => one.value === preset) : -1;
  if (wanted >= 0) return wanted;
  const index = choices.findIndex((one) => !one.keep);
  return index < 0 ? 0 : index;
}

// ── new group names (mirrors `slugOf` / `groupIdForName` in the server's sort-classify.ts) ──

const RESERVED_IDS: Record<string, string> = {
  important: IMPORTANT_ID,
  'not important': NOT_IMPORTANT_ID,
};

export function slugOf(name: string): string {
  return name.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');
}

export function groupIdForName(name: string): string {
  return RESERVED_IDS[name.trim().toLowerCase()] ?? `u:${slugOf(name)}`;
}

/** The id a rule's `then` lands in: a listed group by its (possibly renamed) name first. */
export function idForTarget(catalog: readonly MailCatalogItem[], name: string): string {
  const lower = name.trim().toLowerCase();
  return catalog.find((one) => one.label.toLowerCase() === lower)?.id ?? groupIdForName(name);
}

export function tooSimilarSentence(a: string, b: string): string {
  return `"${a}" and "${b}" are too similar. Rename one of them.`;
}

/**
 * Why a typed new group name cannot be used, or null when it can.
 * An empty field returns '' (Next stays disabled, but there is nothing to say yet).
 */
export function newGroupProblem(name: string, catalog: readonly MailCatalogItem[]): string | null {
  const trimmed = name.trim();
  if (!trimmed) return '';
  if (/[\r\n]/.test(name)) return 'A group name must fit on one line.';
  if (trimmed.length > MAX_GROUP_NAME) return `A group name is at most ${MAX_GROUP_NAME} characters.`;
  const known = [IMPORTANT_LABEL, NOT_IMPORTANT_LABEL, ...catalog.map((one) => one.label)];
  const lower = trimmed.toLowerCase();
  if (known.some((one) => one.toLowerCase() === lower) || RESERVED_IDS[lower]) return COPY.groupExists;
  const id = groupIdForName(trimmed);
  const collision = catalog.find((one) => one.id === id || groupIdForName(one.label) === id);
  if (collision) return tooSimilarSentence(collision.label, trimmed);
  if (slugOf(trimmed) === '') return 'A group name needs at least one letter or digit.';
  return null;
}

// ── step 2: drafts ──

export interface RuleOption {
  /** Stable React key and radio value. */
  key: string;
  kind: MailDraftKind | 'model';
  when: MailRuleWhen;
  then: string;
  summary: string;
  label?: string;
  matches: number;
  moves: number;
  samples: MailSample[];
  shadows: MailShadow[];
  partial?: boolean;
  fromNote: boolean;
}

/** direct and not-direct share a rank: the server already put the one matching this mail first. */
const KIND_RANK: Record<MailDraftKind, number> = {
  'sender-direct': 0,
  'sender-not-direct': 0,
  'sender-subject': 1,
  sender: 2,
  message: 3,
};

/** The local drafts in the order section 11 fixes. A stable sort keeps the server's order in a rank. */
export function localOptions(response: Pick<MailProposeResponse, 'drafts'>): RuleOption[] {
  return response.drafts
    .map((draft, index) => ({ draft, index }))
    .sort((a, b) => (KIND_RANK[a.draft.kind] - KIND_RANK[b.draft.kind]) || (a.index - b.index))
    .map(({ draft }) => ({
      key: draft.kind,
      kind: draft.kind,
      when: draft.when,
      then: draft.then,
      summary: draft.summary,
      ...(draft.label ? { label: draft.label } : {}),
      matches: draft.matches,
      moves: draft.moves,
      samples: draft.samples,
      shadows: draft.shadows,
      fromNote: false,
    }));
}

/** The model's draft as an option, or null when there is none worth showing. */
export function modelOption(model: MailProposeResponse['model'] | null | undefined): RuleOption | null {
  if (!model || model.status !== 'ok' || !model.draft) return null;
  const draft = model.draft;
  return {
    key: 'model', kind: 'model', when: draft.when, then: draft.then, summary: draft.summary,
    matches: draft.matches, moves: draft.moves, samples: [], shadows: [], fromNote: true,
  };
}

/** What the reserved model cell says once the model step is over, or null while it runs or when it worked. */
export function modelCellSentence(model: MailProposeResponse['model'] | null | undefined): string | null {
  if (!model || model.status === 'ok' || model.status === 'skipped') return null;
  return model.reason === 'recipients-unknown' ? COPY.recipientsUnknown : COPY.modelFailed;
}

/**
 * The option picked for the person until they touch the radios: the first one, except that an option
 * moving more mail than the plain `sender` draft is never the default (it falls to the next one).
 */
export function defaultOptionKey(options: readonly RuleOption[]): string | null {
  const sender = options.find((one) => one.kind === 'sender');
  const cap = sender ? sender.moves : Number.POSITIVE_INFINITY;
  const pick = options.find((one) => one.moves <= cap) ?? options[0];
  return pick ? pick.key : null;
}

/** The matches line, as parts, so the moves number can be bold without the component building text. */
export function matchesLine(
  option: Pick<RuleOption, 'matches' | 'moves' | 'partial'>,
  allInboxes: boolean,
): { head: string; moves: string | null; bold: boolean } {
  const n = option.matches;
  const where = allInboxes ? 'in your inboxes' : 'in this inbox';
  const head = `Matches ${option.partial ? 'at least ' : ''}${n.toLocaleString('en-US')} ${n === 1 ? 'mail' : 'mails'} ${where}`;
  const showMoves = option.moves < option.matches;
  return {
    head,
    moves: showMoves ? `moves ${option.moves.toLocaleString('en-US')}` : null,
    bold: option.moves > BOLD_MOVES_OVER,
  };
}

export function shadowSentence(shadow: MailShadow): string {
  const n = shadow.mails;
  return `This overrides your rule "${shadow.summary}" for ${n.toLocaleString('en-US')} ${n === 1 ? 'mail' : 'mails'}.`;
}

/** The coverage line under the drafts, or null when Walnut knows every recipient list. */
export function recipientsSentence(recipients: MailProposeResponse['recipients']): string | null {
  if (recipients.thisMail === 'unknown') return COPY.recipientsUnknown;
  if (recipients.known >= recipients.of) return null;
  return `Walnut knows the recipients of ${recipients.known.toLocaleString('en-US')} of ${recipients.of.toLocaleString('en-US')} mails from this sender.`;
}

// ── step 4: what Save rule writes ──

/** `r-` + 6 hex, the id shape the rules file uses. */
export function newRuleId(random: () => number = Math.random): string {
  let out = '';
  for (let i = 0; i < 6; i += 1) out += Math.floor(random() * 16).toString(16);
  return `r-${out}`;
}

/** Today as `YYYY-MM-DD` in local time (the day the person made the correction). */
export function todayIso(now: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** A rule as it goes back to the server: the view-only `summary` stripped. */
export function storedRule(rule: MailRuleView | MailRule): MailRule {
  const { summary: _summary, ...rest } = rule as MailRuleView;
  return rest;
}

export interface RulesDoc { groups: string[]; rules: MailRule[] }

/** The file's rules and groups as they stand, ready to be edited and sent back. */
export function docOf(current: { groups: string[]; rules: ReadonlyArray<MailRuleView | MailRule> }): RulesDoc {
  return { groups: [...current.groups], rules: current.rules.map(storedRule) };
}

/**
 * The doc `Save rule` sends: the new rule first (or at `insertAt`, under the earlier rule the person
 * chose to keep first), `source: learned`, the note verbatim, and a new group appended to `groups`.
 */
export function withLearnedRule(
  current: RulesDoc,
  input: {
    rule: Pick<RuleOption, 'when' | 'then' | 'label'>; note: string; id: string; created: string; newGroup?: string; insertAt?: number;
    /** A keep-out-of-Inbox rule (the group card's `Keep out of Inbox…`). */
    skipInbox?: boolean;
  },
): RulesDoc {
  const note = input.note.trim() ? input.note : undefined;
  const rule: MailRule = {
    id: input.id,
    when: input.rule.when,
    then: input.rule.then,
    source: 'learned',
    ...(note !== undefined ? { note } : {}),
    created: input.created,
    ...(input.rule.label ? { label: input.rule.label } : {}),
    ...(input.skipInbox ? { skipInbox: true } : {}),
  };
  const at = Math.max(0, Math.min(input.insertAt ?? 0, current.rules.length));
  const rules = [...current.rules.slice(0, at), rule, ...current.rules.slice(at)];
  const groups = input.newGroup && !current.groups.some((one) => one.toLowerCase() === input.newGroup!.toLowerCase())
    ? [...current.groups, input.newGroup]
    : [...current.groups];
  return { groups, rules };
}

/**
 * Undo of a save: those rules removed, and a group the save created dropped too when no remaining
 * rule still sends mail there (no empty group is left behind).
 */
export function withoutRules(current: RulesDoc, ruleIds: readonly string[], createdGroup?: string): RulesDoc {
  const drop = new Set(ruleIds);
  const rules = current.rules.filter((one) => !one.id || !drop.has(one.id));
  const referenced = (name: string) => rules.some((one) => one.then.trim().toLowerCase() === name.trim().toLowerCase());
  const groups = createdGroup && !referenced(createdGroup)
    ? current.groups.filter((one) => one.trim().toLowerCase() !== createdGroup.trim().toLowerCase())
    : [...current.groups];
  return { groups, rules };
}

export function savedSentence(moves: number, targetLabel: string): string {
  const n = `${moves.toLocaleString('en-US')} ${moves === 1 ? 'mail' : 'mails'}`;
  // `Not important` is not a place: the mail leaves Important for whichever group Walnut picks.
  if (targetLabel.trim().toLowerCase() === NOT_IMPORTANT_LABEL.toLowerCase()) return `Saved. ${n} moved out of Important.`;
  return `Saved. ${n} moved to ${targetLabel}.`;
}

export function saveFailedSentence(reason: string): string {
  const clean = reason.trim().replace(/[.\s]+$/, '');
  return `Couldn't save the rule: ${clean || 'the server did not answer'}.`;
}

// ── what a failed write said ──

export type SaveRefusal =
  | { kind: 'changed'; message: string }
  | { kind: 'invalid'; message: string; field?: string; index?: number }
  | { kind: 'network'; message: string };

/** Reads an `ApiError`-shaped failure (status + parsed JSON body) into the three cases the UI draws. */
export function saveRefusalOf(error: unknown): SaveRefusal {
  const status = (error as { status?: unknown })?.status;
  const body = (error as { body?: unknown })?.body as
    | { error?: unknown; message?: unknown; errors?: Array<{ message?: unknown; field?: unknown; index?: unknown }> }
    | undefined;
  if (status === 409 && body?.error === 'changed') return { kind: 'changed', message: COPY.changedOnDisk };
  if (status === 400) {
    const list = body?.errors;
    const first = Array.isArray(list) ? list[0] : undefined;
    const message = typeof first?.message === 'string' ? first.message
      : typeof body?.message === 'string' ? body.message : 'The rule was not accepted.';
    return {
      kind: 'invalid',
      message,
      ...(typeof first?.field === 'string' ? { field: first.field } : {}),
      ...(typeof first?.index === 'number' ? { index: first.index } : {}),
    };
  }
  const reason = typeof body?.message === 'string' ? body.message
    : error instanceof Error ? error.message : String(error ?? '');
  return { kind: 'network', message: saveFailedSentence(reason) };
}

// ── Undo of a learned save (every card that saves a rule shares it) ──

export interface RulesApi {
  get: () => Promise<{ groups: string[]; rules: ReadonlyArray<MailRuleView | MailRule>; fileRev: string }>;
  put: (body: RulesDoc & { baseRev: string }) => Promise<{ fileRev: string }>;
}

/**
 * Removes exactly the rules a save added (and the group it created, when nothing else uses it).
 * Chained on the save's own `fileRev`; when the file moved since (409 changed), it re-reads the file
 * and removes the same ids from what is on disk now, so an Undo never writes back a stale copy.
 */
export async function undoLearnedRules(
  api: RulesApi,
  input: { doc: RulesDoc; fileRev: string; ruleIds: string[]; createdGroup?: string },
): Promise<{ ok: true; fileRev: string } | { ok: false; message: string }> {
  try {
    const done = await api.put({ ...withoutRules(input.doc, input.ruleIds, input.createdGroup), baseRev: input.fileRev });
    return { ok: true, fileRev: done.fileRev };
  } catch (error) {
    if (saveRefusalOf(error).kind !== 'changed') return { ok: false, message: undoFailedSentence(error) };
    try {
      const fresh = await api.get();
      const done = await api.put({ ...withoutRules(docOf(fresh), input.ruleIds, input.createdGroup), baseRev: fresh.fileRev });
      return { ok: true, fileRev: done.fileRev };
    } catch (again) {
      return { ok: false, message: undoFailedSentence(again) };
    }
  }
}

function undoFailedSentence(error: unknown): string {
  const refusal = saveRefusalOf(error);
  const reason = refusal.kind === 'network'
    ? refusal.message.replace(/^Couldn't save the rule: /, '').replace(/\.$/, '')
    : refusal.message.replace(/\.$/, '');
  return `Couldn't undo: ${reason}.`;
}

export function undoneSentence(rules: number): string {
  return rules === 1 ? 'Rule removed. The mail is back where it was.' : `${rules.toLocaleString('en-US')} rules removed. The mail is back where it was.`;
}
