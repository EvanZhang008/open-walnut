/**
 * `PW_MAIL_GROUPS=1`: the inbox-sorting message set (spec 14.1), two adopted accounts.
 *
 * - marina: the IMAP shape. Every row has an address, To and Cc are separate, it can mark read one
 *   at a time AND many at once, it can send, it answers `categoryHints` and `fetchListHeaders`.
 * - ferry: the Outlook shape. `from.address` is EMPTY on every row (display names only), To and Cc
 *   arrive merged, recipients ride only the newest rows, it can mark read one at a time but has NO
 *   `markReadMany`, it cannot send, and it has neither hint method.
 *
 * Every named shape of the spec's table is ONE row with a fixed id (exported below), so a spec can
 * name the row it is about. The rest are fillers at the real proportions. All state a test needs to
 * read back (flags, the mark-read log, header fetches, unsubscribe requests, model calls) lives on
 * ONE object on `globalThis`, because the plugin loader and the fixture server may hold two
 * instances of this module and a counter split across them would read zero.
 *
 * `PW_MAIL_GROUPS_DENSE=1` swaps the fillers for `groups-dense.mjs` (1,500 rows per account).
 */
import { denseFerry, denseMarina } from './groups-dense.mjs';

export const groupsOn = process.env.PW_MAIL_GROUPS === '1' || process.env.PW_MAIL_GROUPS_DENSE === '1';
export const groupsDense = process.env.PW_MAIL_GROUPS_DENSE === '1';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const START = Date.now();

export const MARINA = 'marina:robin@marina.example.invalid';
export const FERRY = 'ferry:robin.harbour@ferry.example.invalid';
export const OWN_NAME = 'Harbour, Robin';
export const MARINA_ADDRESS = 'robin@marina.example.invalid';
export const FERRY_ADDRESS = 'robin.harbour@ferry.example.invalid';

// The named rows of spec 14.1 (marina = A, ferry = B).
export const ROW = {
  review: 'INBOX:21:101',
  oncall: 'INBOX:21:102',
  issues: 'INBOX:21:103',
  codeHost: 'INBOX:21:104',
  oneClick: 'INBOX:21:105',
  mailtoA: 'INBOX:21:106',
  mailtoB: 'INBOX:21:107',
  linkOnly: 'INBOX:21:108',
  precedence: 'INBOX:21:109',
  autoSubmitted: 'INBOX:21:110',
  direct: 'INBOX:21:111',
  groupAlias: 'INBOX:21:112',
  ccOnly: 'INBOX:21:113',
  correspondent: 'INBOX:21:114',
  news: 'INBOX:21:115',
  offers: 'INBOX:21:116',
  statements: 'INBOX:21:117',
  tidewear: 'INBOX:21:118',
  harbourClub: 'INBOX:21:119',
  carol: 'INBOX:21:120',
  lateHeaders: 'INBOX:21:121',
  payroll: 'INBOX:31:201',
  brand: 'INBOX:31:202',
  ferryDirect: 'INBOX:31:203',
  outOfOffice: 'INBOX:31:204',
  noRecipients: 'INBOX:31:205',
  survey: 'INBOX:31:206',
  /** Change Desk's newest mail: To the account's own display name. */
  changeDirect: 'INBOX:31:301',
  /** Change Desk's second newest: only group aliases. */
  changeAlias: 'INBOX:31:302',
  /** Change Desk's oldest: no recipients at all. */
  changeOld: 'INBOX:31:320',
  /** marina's Sent row that makes `correspondent` a correspondent. */
  sentToCorrespondent: 'Sent:21:1',
};

/**
 * The built-in verdict for each named row: what the server falls back on for mail the model has not
 * labeled (read history, a model that is down). There are no built-in groups; a not-important row
 * then sits in its sender's group.
 */
export const EXPECTED_BUILTIN = {
  [ROW.review]: 'transactional', [ROW.oncall]: 'transactional', [ROW.issues]: 'transactional',
  [ROW.codeHost]: 'transactional', [ROW.oneClick]: 'bulk', [ROW.mailtoA]: 'list',
  [ROW.mailtoB]: 'list', [ROW.linkOnly]: 'list', [ROW.precedence]: 'bulk',
  [ROW.autoSubmitted]: 'transactional', [ROW.direct]: 'direct', [ROW.groupAlias]: 'group-alias',
  [ROW.ccOnly]: 'direct', [ROW.correspondent]: 'correspondent', [ROW.news]: 'bulk',
  [ROW.offers]: 'bulk', [ROW.statements]: 'transactional', [ROW.tidewear]: 'bulk',
  [ROW.harbourClub]: 'unsure', [ROW.carol]: 'unsure', [ROW.lateHeaders]: 'bulk',
  [ROW.payroll]: 'transactional', [ROW.brand]: 'unsure', [ROW.ferryDirect]: 'direct',
  [ROW.outOfOffice]: 'group-alias', [ROW.noRecipients]: 'person', [ROW.survey]: 'transactional',
  [ROW.changeDirect]: 'unsure', [ROW.changeAlias]: 'unsure', [ROW.changeOld]: 'unsure',
};

/** The built-in reasons that answer Important; every other one answers Not important. */
export const IMPORTANT_BUILTINS = ['correspondent', 'direct', 'person'];

/** The mailto list both `mailtoA` and `mailtoB` belong to (one ledger key for the two). */
export const MAILTO_LIST_ID = 'bulletin.tidings.example.invalid';
export const UNSUB_TARGET_HOST = 'leave.example.invalid';
export const CHANGE_DESK = 'Change Desk';
export const CHANGE_DESK_MAILS = 20;

// Shared state (one object per process, see the header).
const STATE_KEY = Symbol.for('walnut.mailGroupsFixture');

/** @returns {{ messages: Map<string, any[]>, seen: Map<string, Set<string>>, markReadLog: any[],
 *   ordinal: number, failRule: null | { after: number, count: number }, headerFetchLog: any[],
 *   unsubLog: any[], modelCalls: any[], delivered: number, categoryCalls: any[], unsubDelayMs?: number }} */
export function groupsState() {
  if (!globalThis[STATE_KEY]) {
    globalThis[STATE_KEY] = {
      messages: new Map(), seen: new Map(), markReadLog: [], ordinal: 0, failRule: null,
      headerFetchLog: [], unsubLog: [], modelCalls: [], delivered: 0, categoryCalls: [],
    };
  }
  return globalThis[STATE_KEY];
}

/** One envelope-shaped row. `to: undefined` means the row carries no recipients at all. */
export function row(accountId, messageId, fields) {
  const at = fields.sentAt ?? START - HOUR;
  return {
    accountId,
    messageId,
    rfcMessageId: fields.rfcMessageId ?? `<${messageId.replace(/:/g, '-')}.${accountId.split(':')[0]}@fixture.example.invalid>`,
    mailboxId: fields.mailboxId ?? 'INBOX',
    from: fields.from,
    ...(fields.to ? { to: fields.to } : {}),
    ...(fields.cc ? { cc: fields.cc } : {}),
    subject: fields.subject,
    snippet: fields.snippet ?? fields.subject.slice(0, 60),
    sentAt: at,
    attachments: [],
    text: fields.text ?? `${fields.subject}\n\nNothing else in this fixture mail.`,
    unread: fields.unread !== false,
    ...(fields.listUnsubscribe ? { listUnsubscribe: fields.listUnsubscribe } : {}),
    ...(fields.bulkHeaders ? { bulkHeaders: fields.bulkHeaders } : {}),
    ...(fields.lateHeaders ? { lateHeaders: fields.lateHeaders } : {}),
    ...(fields.category ? { category: fields.category } : {}),
    // The generator's own label for the shape (the density test reads it; never sent to the base).
    ...(fields.kind ? { kind: fields.kind } : {}),
  };
}

export const ME_A = [{ name: OWN_NAME, address: MARINA_ADDRESS }];
const ago = (hours) => START - hours * HOUR;
const oneClick = (path) => ({ https: [`https://${UNSUB_TARGET_HOST}/${path}`], oneClick: true });

/** marina's named rows (A in the spec's table). */
function marinaNamed() {
  const m = (id, fields) => row(MARINA, id, fields);
  return [
    m(ROW.review, { from: { name: 'Review Desk', address: 'no-reply@review.example.invalid' }, to: ME_A,
      subject: '[Action Required] Review the dock schedule change 4471', sentAt: ago(1) }),
    m(ROW.oncall, { from: { name: 'Pager', address: 'noreply-oncall-notifications@page.example.invalid' }, to: ME_A,
      subject: 'Page: berth sensor 12 offline', sentAt: ago(2) }),
    m(ROW.issues, { from: { name: 'Ticket Board', address: 'issues@tickets.example.invalid' }, to: ME_A,
      subject: 'Ticket 8812 was assigned to you', sentAt: ago(3) }),
    m(ROW.codeHost, { from: { name: 'Code Host', address: 'notifications@code.example.invalid' }, to: ME_A,
      subject: 'New comment on pull request 77', sentAt: ago(4) }),
    m(ROW.oneClick, { from: { name: 'Shop Deals', address: 'hello@em.shop.example.invalid' }, to: ME_A,
      subject: 'Your weekend picks are here', sentAt: ago(5), listUnsubscribe: oneClick('u/one-click') }),
    m(ROW.mailtoA, { from: { name: 'Tidings Bulletin', address: 'bulletin@tidings.example.invalid' }, to: ME_A,
      subject: 'Tidings Bulletin, issue 41', sentAt: ago(6),
      listUnsubscribe: { mailto: ['mailto:leave@tidings.example.invalid'], oneClick: false, listId: MAILTO_LIST_ID } }),
    m(ROW.mailtoB, { from: { name: 'Tidings Bulletin', address: 'bulletin@tidings.example.invalid' }, to: ME_A,
      subject: 'Tidings Bulletin, issue 40', sentAt: ago(30), unread: false,
      listUnsubscribe: { mailto: ['mailto:leave@tidings.example.invalid'], oneClick: false, listId: MAILTO_LIST_ID } }),
    m(ROW.linkOnly, { from: { name: 'Almanac Dispatch', address: 'dispatch@almanac.example.invalid' }, to: ME_A,
      subject: 'This month in the almanac', sentAt: ago(7),
      listUnsubscribe: { https: [`https://${UNSUB_TARGET_HOST}/u/link-only`], oneClick: false } }),
    m(ROW.precedence, { from: { name: 'Sam Keel', address: 'sam.keel@almanac.example.invalid' }, to: ME_A,
      subject: 'Moorings digest for members', sentAt: ago(8), bulkHeaders: { precedence: 'bulk' } }),
    m(ROW.autoSubmitted, { from: { name: 'Lee Moor', address: 'lee.moor@yard.example.invalid' }, to: ME_A,
      subject: 'Automatic reply: away until Monday', sentAt: ago(9), bulkHeaders: { autoSubmitted: 'auto-generated' } }),
    m(ROW.direct, { from: { name: 'Carol Pier', address: 'carol.pier@friend.example.invalid' }, to: ME_A,
      subject: 'Lunch on the quay Thursday?', sentAt: ago(10) }),
    m(ROW.groupAlias, { from: { name: 'Bo Tiller', address: 'bo.tiller@marina.example.invalid' },
      to: [{ name: 'Crew', address: 'crew@marina.example.invalid' }], subject: 'Crew rota for the regatta', sentAt: ago(11) }),
    m(ROW.ccOnly, { from: { name: 'Ada Rudder', address: 'ada.rudder@marina.example.invalid' },
      to: [{ name: 'Bo Tiller', address: 'bo.tiller@marina.example.invalid' }], cc: ME_A,
      subject: 'Fuel dock invoice, copying Robin', sentAt: ago(12) }),
    m(ROW.correspondent, { from: { name: 'Jo Quay', address: 'jo.quay@harbourmaster.example.invalid' }, to: ME_A,
      subject: 'Re: slip 14 paperwork', sentAt: ago(13) }),
    m(ROW.news, { from: { name: 'Shop News', address: 'news@shop.example.invalid' }, to: ME_A,
      subject: 'New arrivals in the chandlery', sentAt: ago(14) }),
    m(ROW.offers, { from: { name: 'Shop Offers', address: 'offers@e.shop.example.invalid' }, to: ME_A,
      subject: 'Twenty percent off rope this week', sentAt: ago(15) }),
    m(ROW.statements, { from: { name: 'Harbour Bank', address: 'statements@bank.example.invalid' }, to: ME_A,
      subject: 'Your September statement is ready', sentAt: ago(16), listUnsubscribe: oneClick('u/statements') }),
    m(ROW.tidewear, { from: { name: 'Tidewear', address: 'tidewear@shop.example.invalid' }, to: ME_A,
      subject: 'Robin, your jacket is back in stock', sentAt: ago(17), category: 'promotions' }),
    m(ROW.harbourClub, { from: { name: 'Harbour Club', address: 'harbourclub@club.example.invalid' }, to: ME_A,
      subject: 'Members evening on Friday', sentAt: ago(18) }),
    m(ROW.carol, { from: { name: 'Carol', address: 'carol@friend.example.invalid' }, to: ME_A,
      subject: 'Photos from the sail', sentAt: ago(19) }),
    m(ROW.lateHeaders, { from: { name: 'Lists News', address: 'news@lists.example.invalid' }, to: ME_A,
      // The OLDEST marina row: the base reads bodies newest first (20 a tick), and a body read would
      // teach it these headers before the checklist's late check could.
      subject: 'The lists weekly', sentAt: ago(24 * 20), lateHeaders: {
        listUnsubscribe: oneClick('u/late'), listUnsubscribePost: 'List-Unsubscribe=One-Click', listId: 'weekly.lists.example.invalid' } }),
  ];
}

export const ME_B = [{ name: OWN_NAME }];
const ALIASES_B = [{ name: 'crew-leads' }, { address: 'dock-team@' }];
export const nameOnly = (name) => ({ name, address: '' });

/** ferry's named rows (B), Change Desk's twenty, all display names only. */
function ferryNamed() {
  const f = (id, fields) => row(FERRY, id, fields);
  const named = [
    f(ROW.payroll, { from: nameOnly('payroll'), subject: 'Your payslip for September is ready', sentAt: ago(1.5) }),
    f(ROW.brand, { from: nameOnly('Brand Tide to Shore'), subject: 'Tide to Shore autumn collection', sentAt: ago(2.5) }),
    f(ROW.ferryDirect, { from: nameOnly('Pier, Dana'), to: ME_B, subject: 'Can you cover the late crossing?', sentAt: ago(3.5) }),
    f(ROW.outOfOffice, { from: nameOnly('Wren, Ash'), to: ALIASES_B, subject: 'Automatic reply: out of the office', sentAt: ago(4.5) }),
    f(ROW.noRecipients, { from: nameOnly('Pier, Dana'), subject: 'Notes from the crossing review', sentAt: ago(400), unread: true }),
    f(ROW.survey, { from: nameOnly('Survey Desk'), subject: 'Tell us about your last crossing', sentAt: ago(5.5) }),
  ];
  for (let i = 0; i < CHANGE_DESK_MAILS; i += 1) {
    const id = `INBOX:31:${301 + i}`;
    const to = i === 0 ? ME_B : i === 1 ? ALIASES_B : undefined;
    named.push(f(id, {
      from: nameOnly(CHANGE_DESK),
      ...(to ? { to } : {}),
      subject: `[Action Required] Change ${5500 + i} needs your approval`,
      // The newest two are fresh; the other eighteen are spread over the last three weeks.
      sentAt: i < 2 ? ago(0.5 + i * 0.25) : ago(40 + i * 24),
      unread: i % 3 !== 2,
    }));
  }
  return named;
}

/** marina's Sent row: Robin wrote to Jo Quay, which makes Jo a correspondent. */
function marinaSent() {
  return [row(MARINA, ROW.sentToCorrespondent, {
    mailboxId: 'Sent',
    from: { name: OWN_NAME, address: MARINA_ADDRESS },
    to: [{ name: 'Jo Quay', address: 'jo.quay@harbourmaster.example.invalid' }],
    subject: 'Slip 14 paperwork', sentAt: ago(26), unread: false,
  })];
}

// Fillers at the real proportions (spec 14.1, small set).
const MARINA_FILLER = [
  { name: 'Build Robot', address: 'noreply@builds.example.invalid', subject: 'Build 30{n} passed' },
  { name: 'Dock Alerts', address: 'alerts@dock.example.invalid', subject: 'Tide gauge reading {n}' },
  { name: 'Calendar', address: 'calendar@calendar.example.invalid', subject: 'Invitation: crew sync {n}' },
  { name: 'Chandlery', address: 'deals@digital.chandlery.example.invalid', subject: 'Weekend offer {n}' },
  { name: 'Sailcloth', address: 'sailcloth@shop.example.invalid', subject: 'New colours, drop {n}' },
  { name: 'Kit Rigger', address: 'kit.rigger@yard.example.invalid', subject: 'Mast inspection notes {n}' },
  { name: 'Ren Sound', address: 'ren.sound@friend.example.invalid', subject: 'Photos, part {n}' },
  { name: 'Donotreply', address: 'donotreply@port.example.invalid', subject: 'Parking permit {n}' },
  { name: 'Tidings', address: 'hello@mail.tidings.example.invalid', subject: 'Tidings extra {n}' },
];
const FERRY_FILLER = [
  'Ferry Line Updates', 'Harbour Supplies Co', 'Brand Tide to Shore', 'Crossing Operations Centre',
  '\u6e2f\u53e3\u6e21\u8f6e', 'Keel, Morgan', 'Sound, Jamie', 'Pier, Zo\u00eb', 'Wren, Ash',
  'Build Alerts', 'Ferry Line Updates', 'Harbour Supplies Co',
];

function marinaFillers(count) {
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const shape = MARINA_FILLER[i % MARINA_FILLER.length];
    const n = String(i + 1);
    out.push(row(MARINA, `INBOX:21:${400 + i}`, {
      from: { name: shape.name, address: shape.address },
      ...(i % 10 === 9 ? {} : { to: ME_A }),
      subject: shape.subject.replace('{n}', n),
      sentAt: ago(21 + i * 5),
      unread: i % 4 !== 3,
      ...(shape.address.startsWith('hello@mail.') ? { listUnsubscribe: oneClick(`u/tidings-${n}`) } : {}),
    }));
  }
  return out;
}

function ferryFillers(count) {
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const name = FERRY_FILLER[i % FERRY_FILLER.length];
    out.push(row(FERRY, `INBOX:31:${500 + i}`, {
      from: nameOnly(name),
      subject: `${i % 2 ? 'Crossing timetable' : 'Terminal notice'} ${i + 1}`,
      sentAt: ago(6 + i * 4),
      unread: i % 3 === 0,
    }));
  }
  return out;
}

/**
 * The Outlook shape's recipients: about 56% of the newest 100 rows carry a `to`, older rows carry
 * none. Named rows keep what they declared; fillers in the newest 100 are topped up evenly.
 */
export function spreadFerryRecipients(rows, namedIds, share = 0.56) {
  const sorted = [...rows].sort((a, b) => b.sentAt - a.sentAt);
  const top = sorted.slice(0, 100);
  const withTo = top.filter((one) => namedIds.has(one.messageId) && one.to).length;
  const fillers = top.filter((one) => !namedIds.has(one.messageId));
  const want = Math.max(0, Math.round(top.length * share) - withTo);
  fillers.forEach((one, j) => {
    const give = Math.floor(((j + 1) * want) / fillers.length) > Math.floor((j * want) / fillers.length);
    if (give) one.to = j % 3 === 0 ? ALIASES_B : ME_B;
  });
  for (const one of sorted.slice(100)) if (!namedIds.has(one.messageId)) delete one.to;
  return rows;
}

/** Every row of both accounts, built once per process and shared through `groupsState()`. */
export function groupsMessages() {
  const state = groupsState();
  if (state.messages.size > 0) return state.messages;
  const marina = [...marinaNamed(), ...marinaSent(), ...(groupsDense ? denseMarina(row, ME_A) : marinaFillers(45))];
  const ferryRows = [...ferryNamed(), ...(groupsDense ? denseFerry(row, ME_B, ALIASES_B) : ferryFillers(84))];
  const namedFerry = new Set(ferryNamed().map((one) => one.messageId));
  spreadFerryRecipients(ferryRows, namedFerry);
  state.messages.set(MARINA, marina);
  state.messages.set(FERRY, ferryRows);
  for (const [accountId, rows] of state.messages) {
    state.seen.set(accountId, new Set(rows.filter((one) => !one.unread).map((one) => one.messageId)));
  }
  return state.messages;
}

export function messagesOf(accountId) {
  return groupsMessages().get(accountId) ?? [];
}

export function isSeen(accountId, messageId) {
  groupsMessages();
  return groupsState().seen.get(accountId)?.has(messageId) ?? false;
}

function envelope(accountId, one) {
  return {
    messageId: one.messageId,
    rfcMessageId: one.rfcMessageId,
    mailboxId: one.mailboxId,
    from: one.from,
    ...(one.to ? { to: one.to } : {}),
    ...(one.cc ? { cc: one.cc } : {}),
    subject: one.subject,
    snippet: one.snippet,
    sentAt: one.sentAt,
    flags: isSeen(accountId, one.messageId) ? ['\\Seen'] : [],
    attachments: [],
    bodyBytes: Buffer.byteLength(one.text, 'utf8'),
    ...(one.listUnsubscribe ? { listUnsubscribe: one.listUnsubscribe } : {}),
    ...(one.bulkHeaders ? { bulkHeaders: one.bulkHeaders } : {}),
  };
}

function notFound(message) {
  const error = new Error(message);
  error.code = 'not-found';
  return error;
}

/**
 * One read-flag change, counted: the Nth id this fixture is asked to change (1-based, across both
 * accounts and both calls) fails when `fail-mark-read` armed a window covering N.
 */
function applyRead(accountId, messageId, read, via) {
  const state = groupsState();
  state.ordinal += 1;
  const ordinal = state.ordinal;
  const rule = state.failRule;
  const failed = !!rule && ordinal >= rule.after && ordinal < rule.after + rule.count;
  state.markReadLog.push({ accountId, messageId, read, via, ordinal, ok: !failed, at: Date.now() });
  if (failed) return { ok: false, reason: 'The fixture server refused this change.' };
  if (!messagesOf(accountId).some((one) => one.messageId === messageId)) return { ok: false, reason: 'no such message' };
  const seen = state.seen.get(accountId);
  if (read) seen.add(messageId);
  else seen.delete(messageId);
  return { ok: true };
}

// The two providers.
const CAPS = {
  search: false, watch: true, drafts: false, markRead: true, flags: false, threads: false,
  sendAsReply: true, bodies: 'both', attachments: 'metadata',
};
const MAILBOXES = {
  [MARINA]: [
    { mailboxId: 'INBOX', name: 'Inbox', role: 'inbox' },
    { mailboxId: 'Sent', name: 'Sent', role: 'sent' },
    { mailboxId: 'Archive', name: 'Archive', role: 'archive' },
  ],
  [FERRY]: [{ mailboxId: 'INBOX', name: 'Inbox', role: 'inbox' }],
};

/**
 * marina's `archiveMany`: the IMAP shape of a MOVE. The message leaves INBOX and arrives in Archive
 * under a NEW id (a new UID there), keeping its read flag. `fail-archive?count=N` refuses the next N.
 */
function archiveOne(messageId) {
  const state = groupsState();
  const rows = messagesOf(MARINA);
  const one = rows.find((candidate) => candidate.messageId === messageId);
  state.archiveLog ??= [];
  if ((state.failArchive ?? 0) > 0) {
    state.failArchive -= 1;
    state.archiveLog.push({ messageId, ok: false, at: Date.now() });
    return { ok: false, reason: 'The fixture server refused this move.' };
  }
  if (!one) return { ok: false, reason: 'no such message' };
  if (one.mailboxId === 'Archive') return { ok: true };
  const seen = state.seen.get(MARINA);
  const wasSeen = seen.has(messageId);
  state.archived = (state.archived ?? 0) + 1;
  one.messageId = `Archive:41:${state.archived}`;
  one.mailboxId = 'Archive';
  seen.delete(messageId);
  if (wasSeen) seen.add(one.messageId);
  state.archiveLog.push({ messageId, movedTo: one.messageId, seen: wasSeen, ok: true, at: Date.now() });
  return { ok: true };
}

/** ferry's per-message read latency, in ms. */
export function readDelayMs() {
  const state = groupsState();
  if (state.ferryReadMs === undefined) {
    const raw = Number(process.env.PW_MAIL_FERRY_READ_MS ?? '');
    state.ferryReadMs = Number.isFinite(raw) && raw >= 0 ? raw : 40;
  }
  return state.ferryReadMs;
}

/** Watch hints: `deliver` pokes these so the base polls at once instead of on its timer. */
function watchers() {
  const state = groupsState();
  state.watchers ??= new Map();
  return state.watchers;
}

export function hintNewMail(accountId, mailbox = 'INBOX') {
  for (const hint of watchers().get(accountId) ?? []) hint({ mailbox });
}

function baseSpec(id, label, accountId, address, send, archive = false) {
  return {
    id,
    label,
    capabilities: { ...CAPS, send, ...(archive ? { archive: true } : {}) },
    setup: { fields: [], submit: async () => { throw new Error('this fixture provider adopts its accounts'); } },
    async listAccounts() {
      return [{ accountId, providerId: id, displayName: OWN_NAME, address, state: 'active' }];
    },
    async health() { return { state: 'ok', checkedAt: Date.now() }; },
    async listMailboxes() {
      return MAILBOXES[accountId].map((mailbox) => {
        const held = messagesOf(accountId).filter((one) => one.mailboxId === mailbox.mailboxId);
        return { ...mailbox, total: held.length, unread: held.filter((one) => !isSeen(accountId, one.messageId)).length };
      });
    },
    watch(watched, onHint) {
      const list = watchers().get(watched) ?? [];
      list.push(onHint);
      watchers().set(watched, list);
      return { dispose() { watchers().set(watched, (watchers().get(watched) ?? []).filter((one) => one !== onHint)); } };
    },
    async poll(_accountId, request) {
      const held = messagesOf(accountId).filter((one) => one.mailboxId === request.mailbox);
      return { messages: held.map((one) => envelope(accountId, one)), cursor: `${request.mailbox}:${held.length}`, more: false };
    },
    async getBody(_accountId, messageId) {
      const one = messagesOf(accountId).find((candidate) => candidate.messageId === messageId);
      if (!one) throw notFound(`no fixture message ${messageId}`);
      // A body read carries the message's own headers, late ones included (the real IMAP path does).
      const late = one.lateHeaders?.listUnsubscribe;
      return { format: 'text', text: one.text, bytes: Buffer.byteLength(one.text, 'utf8'), ...(late ? { listUnsubscribe: late } : {}) };
    },
    async markRead(_accountId, messageId, read) {
      // The Outlook shape is SLOW per message (a real one downloads the conversation): 40 ms by
      // default, `PW_MAIL_FERRY_READ_MS` or `POST /__fixture/read-delay?ms=` to change it.
      const delay = accountId === FERRY ? readDelayMs() : 0;
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      const outcome = applyRead(accountId, messageId, read, 'markRead');
      if (!outcome.ok) throw new Error(outcome.reason);
    },
  };
}

/** marina: the IMAP shape (bulk read, sends, archive moves, category hints, late list headers). */
export const marinaSpec = {
  ...baseSpec('marina', 'Marina Mail', MARINA, MARINA_ADDRESS, true, true),
  async markReadMany(_accountId, messageIds, read) {
    return messageIds.map((messageId) => ({ messageId, ...applyRead(MARINA, messageId, read, 'markReadMany') }));
  },
  async archiveMany(_accountId, messageIds) {
    return messageIds.map((messageId) => ({ messageId, ...archiveOne(messageId) }));
  },
  async categoryHints(_accountId, mailboxId) {
    groupsState().categoryCalls.push({ mailboxId, at: Date.now() });
    const held = messagesOf(MARINA).filter((one) => one.mailboxId === mailboxId);
    return {
      promotions: held.filter((one) => one.category === 'promotions').map((one) => one.messageId),
      social: held.filter((one) => one.category === 'social').map((one) => one.messageId),
    };
  },
  async fetchListHeaders(_accountId, mailboxId, messageIds) {
    const log = groupsState().headerFetchLog;
    return messageIds.map((messageId) => {
      const one = messagesOf(MARINA).find((candidate) => candidate.messageId === messageId && candidate.mailboxId === mailboxId);
      // PEEK, always: a header fetch never changes `\Seen` (the log proves it to the spec).
      log.push({ messageId, peek: true, seenBefore: isSeen(MARINA, messageId), at: Date.now() });
      return { messageId, headers: one?.lateHeaders ?? null };
    });
  },
  async send(_accountId, mail) {
    const to = (mail.to ?? []).map((one) => one.address);
    if (to.some((address) => /^leave@/.test(address ?? ''))) {
      const delay = groupsState().unsubDelayMs ?? 0;
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      groupsState().unsubLog.push({ kind: 'mailto', to, subject: mail.subject, at: Date.now() });
    }
    groupsState().sends ??= [];
    groupsState().sends.push({ to, subject: mail.subject, at: Date.now() });
    return { providerMessageId: `<groups-send-${groupsState().sends.length}@example.invalid>`, acceptedAt: Date.now() };
  },
};

/** ferry: the Outlook shape (per-message read only, cannot send or move, no hint methods). */
export const ferrySpec = {
  ...baseSpec('ferry', 'Ferry Mail', FERRY, FERRY_ADDRESS, false),
  // Required by the contract; `capabilities.send: false` means the base never calls it.
  async send() { throw Object.assign(new Error('This account cannot send mail.'), { code: 'unsupported' }); },
};

/** Register both providers, adopted (no setup dialog). Returns the loader's Disposable. */
export function activateGroups(base) {
  groupsMessages();
  const handles = [base.registerProvider(marinaSpec), base.registerProvider(ferrySpec)];
  return { dispose: () => { for (const handle of handles) handle.dispose(); } };
}

export const GROUPS_DAY = DAY;
