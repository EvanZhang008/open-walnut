/**
 * The `PW_MAIL_GROUPS` fixture's own HTTP endpoints, served on the fixture's port (the Vite server
 * `mail-app-server.ts` starts) under `/__fixture/`. They read and arm the state `groups-set.mjs`
 * keeps on `globalThis`, so a spec can prove what reached the "mail server" instead of trusting what
 * the console said about it.
 *
 *   POST /__fixture/fail-mark-read?after=N&count=M   the Nth read-flag change from now, and the M-1 after it, fail
 *   POST /__fixture/deliver?count=N&people=K&account=marina|ferry&kind=list   new unread mail, K from a person
 *   GET  /__fixture/mark-read-log                    every read-flag change asked for, in order
 *   GET  /__fixture/flags?account=<id>&message=<id>  the server's own \Seen for one message
 *   GET  /__fixture/header-fetch-log                 every late list-header fetch (messageId, peek)
 *   GET  /__fixture/unsub-log                        every request that reached an unsubscribe target
 *   GET  /__fixture/model-calls                      every call to the faked rule model
 *   POST /__fixture/read-delay?ms=N                  ferry's per-message read latency (default 40 ms)
 *   POST /__fixture/unsub-delay?ms=N                 how long each unsubscribe target takes to answer (default 0)
 *   POST /__fixture/reset-logs                       empty the four logs (flags stay)
 *   POST /__fixture/label-model?mode=ok|down|invalid|partial|slow   the labeling model's behaviour
 *   GET  /__fixture/label-calls                      every call to the faked labeling model
 *   GET  /__fixture/archive-log                      every archive move asked of marina (id, new id, ok)
 *   POST /__fixture/fail-archive?count=N             marina refuses the next N moves
 */
import {
  FERRY, MARINA, ME_A, ME_B, groupsMessages, groupsState, hintNewMail, isSeen, nameOnly, readDelayMs, row,
} from './groups-set.mjs';

/**
 * `deliver`: N new unread mails into an inbox, K of them from a person writing to Robin directly,
 * the rest at the dense proportions. Newest of all, fresh uids, and a watch hint so the base polls.
 * `kind: 'list'` makes the non-person ones a newsletter whose only way out is a mailto: on ferry,
 * the account that cannot send, that is the "Copy address / open the mail app" case (an IMAP
 * account without outgoing mail has the same shape).
 */
export function deliver({ count = 1, people = 0, accountId = MARINA, kind = '' } = {}) {
  const state = groupsState();
  const rows = groupsMessages().get(accountId);
  if (!rows) return [];
  const made = [];
  for (let i = 0; i < count; i += 1) {
    state.delivered += 1;
    const n = state.delivered;
    const messageId = `INBOX:${accountId === MARINA ? 21 : 31}:${90000 + n}`;
    const person = i < people;
    const fields = person
      ? {
        from: accountId === MARINA
          ? { name: 'Ren Sound', address: 'ren.sound@friend.example.invalid' }
          : nameOnly('Keel, Morgan'),
        to: accountId === MARINA ? ME_A : ME_B,
        subject: `Quick question ${n}`,
      }
      : kind === 'list'
        ? {
          from: { name: 'Harbour Almanac', address: 'almanac@almanac.example.invalid' },
          to: accountId === MARINA ? ME_A : ME_B,
          subject: `Harbour Almanac, issue ${n}`,
          listUnsubscribe: { mailto: ['mailto:leave@almanac.example.invalid'], oneClick: false, listId: 'almanac.example.invalid' },
        }
      : accountId === MARINA
        ? { from: { name: 'Build Robot', address: 'noreply@builds.example.invalid' }, to: ME_A, subject: `Build 9${n} passed` }
        : { from: nameOnly('payroll'), subject: `Payroll notice ${n}` };
    const one = row(accountId, messageId, { ...fields, sentAt: Date.now() + i });
    rows.push(one);
    made.push({ accountId, messageId, subject: one.subject });
  }
  hintNewMail(accountId);
  return made;
}


function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function intParam(params, name, fallback) {
  const raw = Number(params.get(name));
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : fallback;
}

function accountParam(params) {
  const raw = params.get('account') ?? '';
  if (raw === 'ferry' || raw === FERRY) return FERRY;
  if (raw === '' || raw === 'marina' || raw === MARINA) return MARINA;
  return raw;
}

/** Answer one `/__fixture/` request. Returns false for anything else, so the caller can fall through. */
export function handleGroupsFixture(req, res) {
  const url = new URL(req.url ?? '/', 'http://fixture.invalid');
  if (!url.pathname.startsWith('/__fixture/')) return false;
  const method = (req.method ?? 'GET').toUpperCase();
  const state = groupsState();
  groupsMessages();
  const route = `${method} ${url.pathname}`;
  switch (route) {
    case 'POST /__fixture/fail-mark-read': {
      const count = intParam(url.searchParams, 'count', 1);
      const after = Math.max(1, intParam(url.searchParams, 'after', 1));
      state.failRule = count > 0 ? { after: state.ordinal + after, count } : null;
      send(res, 200, { ok: true, failRule: state.failRule, ordinal: state.ordinal });
      return true;
    }
    case 'POST /__fixture/deliver': {
      const made = deliver({
        count: Math.max(1, intParam(url.searchParams, 'count', 1)),
        people: intParam(url.searchParams, 'people', 0),
        accountId: accountParam(url.searchParams),
        kind: url.searchParams.get('kind') === 'list' ? 'list' : '',
      });
      send(res, 200, { ok: true, delivered: made });
      return true;
    }
    case 'GET /__fixture/mark-read-log':
      send(res, 200, { calls: state.markReadLog.length, log: state.markReadLog });
      return true;
    case 'GET /__fixture/flags': {
      const accountId = accountParam(url.searchParams);
      const messageId = url.searchParams.get('message') ?? '';
      const known = (groupsMessages().get(accountId) ?? []).some((one) => one.messageId === messageId);
      const seen = isSeen(accountId, messageId);
      send(res, known ? 200 : 404, { accountId, messageId, known, seen, flags: seen ? ['\\Seen'] : [] });
      return true;
    }
    case 'GET /__fixture/header-fetch-log':
      send(res, 200, { calls: state.headerFetchLog.length, log: state.headerFetchLog });
      return true;
    case 'GET /__fixture/unsub-log':
      send(res, 200, { calls: state.unsubLog.length, log: state.unsubLog });
      return true;
    case 'GET /__fixture/model-calls':
      send(res, 200, { calls: state.modelCalls.length, log: state.modelCalls });
      return true;
    case 'POST /__fixture/label-model': {
      const mode = url.searchParams.get('mode') ?? 'ok';
      if (!['ok', 'down', 'invalid', 'partial', 'slow'].includes(mode)) {
        send(res, 400, { error: 'unknown-mode', mode });
        return true;
      }
      state.labelMode = mode;
      send(res, 200, { ok: true, mode });
      return true;
    }
    case 'GET /__fixture/label-calls': {
      const calls = state.labelCalls ?? [];
      const summaries = state.summaryCalls ?? [];
      send(res, 200, { calls: calls.length, log: calls, summaryCalls: summaries.length });
      return true;
    }
    case 'GET /__fixture/archive-log':
      send(res, 200, { log: state.archiveLog ?? [] });
      return true;
    case 'POST /__fixture/fail-archive':
      state.failArchive = intParam(url.searchParams, 'count', 1);
      send(res, 200, { ok: true, count: state.failArchive });
      return true;
    case 'POST /__fixture/read-delay':
      readDelayMs();
      state.ferryReadMs = intParam(url.searchParams, 'ms', 40);
      send(res, 200, { ok: true, ms: state.ferryReadMs });
      return true;
    case 'POST /__fixture/unsub-delay':
      state.unsubDelayMs = intParam(url.searchParams, 'ms', 0);
      send(res, 200, { ok: true, ms: state.unsubDelayMs });
      return true;
    case 'POST /__fixture/reset-logs':
      state.markReadLog.length = 0;
      state.headerFetchLog.length = 0;
      state.unsubLog.length = 0;
      state.modelCalls.length = 0;
      if (state.labelCalls) state.labelCalls.length = 0;
      if (state.summaryCalls) state.summaryCalls.length = 0;
      state.failRule = null;
      send(res, 200, { ok: true });
      return true;
    default:
      send(res, 404, { error: 'unknown-fixture-route', route });
      return true;
  }
}
