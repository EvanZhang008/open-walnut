/**
 * `PW_MAIL_GROUPS_DENSE=1`: 1,500 rows per account at the proportions measured on a real cache
 * (spec 14.1), NOT a round robin over the named shapes. A round robin makes Important look small and
 * even; the real inbox is dominated by a few prolific senders that are not people.
 *
 * Deterministic: a seeded shuffle spreads the shapes over time, so the newest page is a mix and the
 * same run twice produces the same rows. Every row carries `kind` (the generator's label for its
 * shape) so the density test can check the proportions without re-deriving them.
 */
const HOUR = 60 * 60 * 1000;
const START = Date.now();
const PER_ACCOUNT = 1_500;

/** The target shares, in percent, that `mail-sort-fixture-density.test.ts` checks within 3 points. */
export const FERRY_SHARES = { orgName: 49, lastFirst: 23, machine: 23, other: 5 };
export const MARINA_SHARES = { machine: 49, marketingSubdomain: 16, brandLocal: 22, person: 12, other: 1 };
export const MARINA_LIST_HEADER_SHARE = 1.5;
export const MARINA_TO_ME_SHARE = 90;

/** ferry's prolific non-person names: three with 150 or more mails each, then a tail. */
export const FERRY_ORG_NAMES = [
  ['Harbour Supplies Co', 170], ['Crossing Operations Centre', 160], ['payroll', 150],
  ['Ferry Line Updates', 22], ['Brand Tide to Shore', 20], ['Terminal Services', 20], ['Quayside Facilities', 20],
  ['Fleet Office', 20], ['Berth Planning', 20], ['Timetable Office', 20], ['Cargo Desk', 20], ['Pier Canteen', 20],
];
/** Names with one or two mails: about a tenth of the non-person rows, as measured. */
const FERRY_TAIL_ROWS = 73;

const LAST_FIRST = [
  'Pier, Dana', 'Wren, Ash', 'Keel, Morgan', 'Sound, Jamie', 'Tiller, Bo', 'Rudder, Ada',
  'Quay, Jo', 'Mast, Rowan', 'Brine, Sky', 'Cove, Lane', 'Pier, Zo\u00eb', 'Strand, Eli',
];
const FERRY_MACHINE = [
  'noreply-oncall-notifications@page.example.invalid', 'issues@tickets.example.invalid',
  'no-reply@review.example.invalid', 'alerts@cost.example.invalid', 'notifications@change.example.invalid',
];
const OTHER_NAMES = ['Morgan Keel', 'Harbour Radio', 'Ferry Friends Club', '\u6e2f\u53e3\u6e21\u8f6e'];

const MARINA_MACHINE = [
  'noreply@builds.example.invalid', 'notifications@code.example.invalid', 'alerts@dock.example.invalid',
  'calendar@calendar.example.invalid', 'no.reply@port.example.invalid', 'donotreply@port.example.invalid',
  'issues@tickets.example.invalid', 'statements@moorings.example.invalid', 'security@account.example.invalid',
];
const MARKETING_SUBDOMAINS = ['digital', 'email', 'hello', 'mailer', 'news', 'info', 'e', 'em', 'mail', 'mkt'];
const BRAND_LOCALS = ['tidewear', 'harbourclub', 'sailcloth', 'ropeworks', 'deckhand', 'bluewater', 'saltline', 'knotty'];
const PEOPLE = [
  'carol.pier', 'ren.sound', 'kit.rigger', 'jo.quay', 'ada.rudder', 'bo.tiller', 'lane.cove', 'eli.strand',
];

/** mulberry32: a tiny seeded PRNG, so the shuffle is the same every run. */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(list, seed) {
  const random = prng(seed);
  for (let i = list.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

const titleOf = (name) => name.replace(/[^a-z]/gi, ' ').trim() || 'Harbour';

/** ferry's 1,500 (display names only; recipients are spread by `spreadFerryRecipients`). */
export function denseFerry(row, _me, _aliases) {
  const shapes = [];
  for (const [name, mails] of FERRY_ORG_NAMES) for (let i = 0; i < mails; i += 1) shapes.push({ kind: 'orgName', name });
  for (let i = 0; i < FERRY_TAIL_ROWS; i += 1) shapes.push({ kind: 'orgName', name: `Harbour Vendor ${Math.floor(i / 2) + 1}` });
  const lastFirst = Math.round((PER_ACCOUNT * FERRY_SHARES.lastFirst) / 100);
  const machine = Math.round((PER_ACCOUNT * FERRY_SHARES.machine) / 100);
  for (let i = 0; i < lastFirst; i += 1) shapes.push({ kind: 'lastFirst', name: LAST_FIRST[i % LAST_FIRST.length] });
  for (let i = 0; i < machine; i += 1) {
    const address = FERRY_MACHINE[i % FERRY_MACHINE.length];
    shapes.push({ kind: 'machine', name: titleOf(address.split('@')[0]), address });
  }
  while (shapes.length < PER_ACCOUNT) shapes.push({ kind: 'other', name: OTHER_NAMES[shapes.length % OTHER_NAMES.length] });
  shuffle(shapes, 31);
  return shapes.map((shape, i) => {
    const automated = shape.kind === 'machine' || shape.name === 'payroll';
    return row('ferry:robin.harbour@ferry.example.invalid', `INBOX:31:${10000 + i}`, {
      kind: shape.kind,
      from: { name: shape.name, address: shape.address ?? '' },
      subject: `${automated ? 'Notice' : 'Update'} ${i + 1} from ${titleOf(shape.name)}`,
      sentAt: START - (6 + i * 2.8) * HOUR,
      // Automated mail is almost all unread (the 1,200-mail bulk case); people and orgs about half.
      unread: automated ? i % 240 !== 7 : i % 2 === 0,
    });
  });
}

/** marina's 1,500 (every row has an address; 90% are To Robin). */
export function denseMarina(row, me) {
  const count = (share) => Math.round((PER_ACCOUNT * share) / 100);
  const shapes = [];
  for (let i = 0; i < count(MARINA_SHARES.machine); i += 1) shapes.push({ kind: 'machine', address: MARINA_MACHINE[i % MARINA_MACHINE.length] });
  for (let i = 0; i < count(MARINA_SHARES.marketingSubdomain); i += 1) {
    shapes.push({ kind: 'marketingSubdomain', address: `store@${MARKETING_SUBDOMAINS[i % MARKETING_SUBDOMAINS.length]}.chandlery.example.invalid` });
  }
  for (let i = 0; i < count(MARINA_SHARES.brandLocal); i += 1) {
    const local = BRAND_LOCALS[i % BRAND_LOCALS.length];
    shapes.push({ kind: 'brandLocal', address: `${local}@shop.example.invalid`, ...(i % 3 === 0 ? { category: 'promotions' } : {}) });
  }
  for (let i = 0; i < count(MARINA_SHARES.person); i += 1) shapes.push({ kind: 'person', address: `${PEOPLE[i % PEOPLE.length]}@friend.example.invalid` });
  while (shapes.length < PER_ACCOUNT) shapes.push({ kind: 'other', address: 'carol@friend.example.invalid' });
  shuffle(shapes, 21);
  const withHeaders = Math.round((PER_ACCOUNT * MARINA_LIST_HEADER_SHARE) / 100);
  let headersGiven = 0;
  return shapes.map((shape, i) => {
    const local = shape.address.split('@')[0];
    const toMe = i % 10 !== 9;
    const listed = shape.kind === 'marketingSubdomain' && headersGiven < withHeaders && i % 5 === 0;
    if (listed) headersGiven += 1;
    return row('marina:robin@marina.example.invalid', `INBOX:21:${10000 + i}`, {
      kind: shape.kind,
      from: { name: titleOf(local), address: shape.address },
      to: toMe ? me : [{ name: 'Crew', address: 'crew@marina.example.invalid' }],
      subject: `${titleOf(local)} message ${i + 1}`,
      sentAt: START - (21 + i * 2.8) * HOUR,
      unread: shape.kind === 'machine' ? i % 240 !== 7 : i % 2 === 0,
      ...(shape.category ? { category: shape.category } : {}),
      ...(listed ? { listUnsubscribe: { https: [`https://leave.example.invalid/u/dense-${i}`], oneClick: true } } : {}),
    });
  });
}
