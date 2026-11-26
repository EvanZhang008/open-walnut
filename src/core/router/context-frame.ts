/**
 * router_context as an agent reads it: what the item's sender wrote inside ONE outside-data envelope
 * (core/outside-content.ts), and Walnut's own fields (ids, the account and message keys, statuses,
 * the router's instructions) outside it, where the agent acts on them.
 *
 * Every field is classified here: an item's field (RouterItem), a ledger row's (RouterRoute, and the
 * fields a history row or an owner row adds) and the answer's own. A key no table names is framed:
 * a field added later without a look here still reaches the agent as data, never as Walnut's word.
 * A Walnut field whose value comes from the item's headers (its key, thread, source) stays outside
 * only in an id's shape (ROUTER_FIELD_SHAPES); in any other it is framed.
 * tests/core/router/context-frame.test.ts holds every table to its type.
 *
 * Pure: the op's handler frames the route's answer, and its shape (ops/router.ts) unframes, folds
 * the histories and frames again, so a `_full` read and a shaped one are framed alike.
 */
import { frameOutsideData, isFramedOutside, isWalnutFramed, outsideDataOf, WALNUT_NOTE_FIELD } from '../outside-content.js';
import { ROUTER_SOURCE_KINDS, type RouterItem, type RouterRoute } from './types.js';

export type FieldClass = 'walnut' | 'outside';

/** Each field of an item. `reference` is how the source adapter says to read the item, not the sender's text. */
export const ROUTER_ITEM_FIELDS = {
  source: 'walnut', key: 'walnut', scopeKey: 'walnut', threadKey: 'walnut', reference: 'walnut',
  sender: 'outside', subject: 'outside', preview: 'outside',
} as const satisfies Record<keyof RouterItem, FieldClass>;

/**
 * Each field of a ledger row, a history row and an owner row. A reason and an evidence line were
 * written by a router after reading the outside item, so they are framed with it; so is a delivery
 * error, whose words a refusing target or a plugin may have written.
 */
export const ROUTER_ROW_FIELDS = {
  areaId: 'walnut', key: 'walnut', source: 'walnut', threadKey: 'walnut', status: 'walnut', taskId: 'walnut',
  ruleId: 'walnut', byTaskId: 'walnut', at: 'walnut', messageId: 'walnut', error: 'outside', origin: 'walnut',
  letterId: 'walnut', letterUnchecked: 'walnut', letterPending: 'walnut',
  sender: 'outside', subject: 'outside', reason: 'outside', evidence: 'outside',
} as const satisfies Record<keyof RouterRoute, FieldClass>;

/** What a history row (context.ts withTargets, historyPreview) and an owner row (ops/router.ts owners) add. */
export const ROUTER_ROW_EXTRA_FIELDS = {
  targetTitle: 'walnut', targetOpen: 'walnut', letter: 'walnut', times: 'walnut',
} as const satisfies Record<string, FieldClass>;

/**
 * An id as a mail header or a source's cache gives it (a Message-ID, a thread id, a channel ts):
 * printable ASCII with no space. A sender can choose these, so a Walnut field holding one stays
 * outside the frame only in this shape; one with words in it (a space, a line, any other character)
 * goes inside, as page-frame.ts does with a page's fields (2026-11-26 review, minor 2). At most 200
 * characters: a real id is shorter, and a longer one can carry a sentence written with underscores,
 * so it goes inside too, where it is still read (2026-11-26 review 3, minor 4).
 */
const ID_TOKEN = /^[\x21-\x7e]{1,200}$/;
const isIdToken = (v: unknown): boolean => typeof v === 'string' && ID_TOKEN.test(v);

/** An item's source: a known kind and id-shaped account, message and version. */
function isRouterSource(v: unknown): boolean {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const src = v as Record<string, unknown>;
  return (ROUTER_SOURCE_KINDS as readonly unknown[]).includes(src.kind) && isIdToken(src.account) && isIdToken(src.message)
    && (src.version === undefined || isIdToken(src.version))
    && Object.keys(src).every((key) => ['kind', 'account', 'message', 'version'].includes(key));
}

/**
 * The Walnut fields whose value comes from the item's own headers or its source's cache, with the
 * shape each must have to stay outside the frame. Every other Walnut field is Walnut's own data (a
 * task id, a status, a time). tests/core/router/context-frame.test.ts holds the header-derived ones here.
 */
export const ROUTER_FIELD_SHAPES: Readonly<Record<string, (value: unknown) => boolean>> = {
  key: isIdToken, scopeKey: isIdToken, threadKey: isIdToken, messageId: isIdToken, source: isRouterSource,
};

/** The answer's own top-level fields that are Walnut's; the item, the route and the lists are split field by field. */
export const ROUTER_CONTEXT_WALNUT_FIELDS = [
  'router', 'instructions', 'trust', 'bodyAvailable', 'bodyTruncated', 'bodyUnavailableReason',
  'attachmentsTruncated', 'attachmentsAvailable',
] as const;

/** The answer's lists of ledger rows. */
export const ROUTER_CONTEXT_ROW_LISTS = ['threadHistory', 'senderHistory', 'threadOwners', 'senderOwners'] as const;

const SPLIT_FIELDS = new Set<string>(['item', 'route', ...ROUTER_CONTEXT_ROW_LISTS]);
const WALNUT_TOP = new Set<string>(ROUTER_CONTEXT_WALNUT_FIELDS);
const ROW_CLASS: Record<string, FieldClass> = { ...ROUTER_ROW_FIELDS, ...ROUTER_ROW_EXTRA_FIELDS };
const ITEM_CLASS: Record<string, FieldClass> = ROUTER_ITEM_FIELDS;

/** Said beside the envelope: how its lists line up with Walnut's. */
export const ROUTER_FRAME_NOTE = 'external_content.data holds what the item\'s sender wrote: its item and route fields belong to item and route, '
  + 'and each row of a list belongs to the row at the same position in the list of the same name outside it.';

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v && typeof v === 'object' && !Array.isArray(v) ? v as Rec : {});

/** One object split by its table: Walnut's fields in their shape, and the rest (unknown keys included) as outside. */
function split(value: unknown, table: Record<string, FieldClass>): { walnut: Rec; outside: Rec } {
  const walnut: Rec = {};
  const outside: Rec = {};
  for (const [key, field] of Object.entries(rec(value))) {
    if (table[key] === 'walnut' && (ROUTER_FIELD_SHAPES[key]?.(field) ?? true)) walnut[key] = field;
    else outside[key] = field;
  }
  return { walnut, outside };
}

/** The route's answer (or a shaped one) framed: see the file comment. Anything that is not an object is returned as it is. */
export function frameRouterContext(result: unknown): unknown {
  if (!result || typeof result !== 'object' || Array.isArray(result) || isWalnutFramed(result)) return result;
  const raw = result as Rec;
  const shown: Rec = {};
  const data: Rec = {};
  for (const [key, value] of Object.entries(raw)) {
    if (SPLIT_FIELDS.has(key)) continue;
    if (WALNUT_TOP.has(key)) shown[key] = value;
    else data[key] = value;
  }
  if ('item' in raw) {
    const { walnut, outside } = split(raw.item, ITEM_CLASS);
    shown.item = walnut;
    data.item = outside;
  }
  if ('route' in raw) {
    if (raw.route && typeof raw.route === 'object') {
      const { walnut, outside } = split(raw.route, ROW_CLASS);
      shown.route = walnut;
      data.route = outside;
    } else shown.route = raw.route ?? null;
  }
  for (const list of ROUTER_CONTEXT_ROW_LISTS) {
    if (!(list in raw)) continue;
    if (!Array.isArray(raw[list])) { data[list] = raw[list]; continue; }
    const rows = (raw[list] as unknown[]).map((row) => split(row, ROW_CLASS));
    shown[list] = rows.map((row) => row.walnut);
    data[list] = rows.map((row) => row.outside);
  }
  // The frame's attributes are Walnut's words about it: only a source in its shape names them.
  const source = rec(rec(raw.item).source);
  const named = isRouterSource(source);
  const attrs: Record<string, string> = named ? { account: String(source.account), message: String(source.message) } : {};
  // Walnut's fields first, then the envelope, then the router's instructions last, where it reads them.
  const { instructions, trust, ...head } = shown;
  return frameOutsideData({ source: named ? String(source.kind) : 'router item', attrs }, data, ROUTER_FRAME_NOTE, {
    before: head,
    after: { ...(instructions !== undefined ? { instructions } : {}), ...(trust !== undefined ? { trust } : {}) },
  });
}

/** A framed answer back to the route's shape, so it can be shaped and framed again. Its outside strings stay cleaned. */
export function unframeRouterContext(result: unknown): unknown {
  if (!isFramedOutside(result)) return result;
  const { external_content: _env, note: _note, [WALNUT_NOTE_FIELD]: _walnutNote, ...shown } = result as Rec;
  const data = rec(outsideDataOf(result));
  const raw: Rec = { ...shown };
  for (const [key, value] of Object.entries(data)) {
    if (key === 'item' || key === 'route') {
      raw[key] = shown[key] && typeof shown[key] === 'object' ? { ...rec(shown[key]), ...rec(value) } : value;
    } else if ((ROUTER_CONTEXT_ROW_LISTS as readonly string[]).includes(key) && Array.isArray(value) && Array.isArray(shown[key])) {
      const walnut = shown[key] as unknown[];
      raw[key] = walnut.map((row, i) => ({ ...rec(row), ...rec(value[i]) }));
    } else raw[key] = value;
  }
  return raw;
}
