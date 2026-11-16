/**
 * A browser under automation is never the person (2026-11-16: a proof-video task typed into
 * another task's composer through headless Chromium on the user's own Walnut, and both rows read
 * `sentBy: "person"`). src/core/sessions/automated-client.ts holds the rule; these pin who counts as
 * automated, that every person source reads as an agent's inside the scope (enumerated from the
 * source, so a new person source is covered or this fails), and that nothing reads the raw person
 * set behind the rule's back.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  AUTOMATED_CLIENT_HEADER, ambientAutomatedClient, automatedClientIsAgent, automatedClientOf, withAutomatedClient,
} from '../../../src/core/sessions/automated-client.js';
import {
  AUTOMATED_SEND_SOURCE, PERSON_ONLY_SOURCES, PERSON_SEND_SOURCES, PERSON_START_SOURCES, isPersonSendSource, isPersonSource, queueSentBy, routeSource,
  sendSourceOf, startRouteSource,
} from '../../../src/core/sessions/send-sent-by.js';
import { attributedUnlessAutomated, frameForSource, frameStartData, frameStartText, readsAsPerson } from '../../../src/core/sessions/send-frame.js';
import { transcriptSentBy } from '../../../src/core/sessions/transcript-sent-by.js';
import { isPersonSendSource as isPhasePersonSend } from '../../../src/core/phase.js';
import { CONTROL_REQUESTS } from '../../../src/core/sessions/walnut-commands.js';
import { AUTOMATED_HEADER, AUTOMATED_PARAM } from '../../../web/src/api/test-run.js';
import { initWithAutomated } from '../../../web/src/api/auth-fetch.js';

const ROOT = path.resolve(__dirname, '../../..');

// Real user agents: the person's browsers, and the automated ones.
const UA = {
  chrome: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
  safari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
  macApp: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)',
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1',
  headless: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/142.0.7444.0 Safari/537.36',
};

describe('who counts as a browser under automation', () => {
  it('a person\'s browsers and the Mac app are not', () => {
    for (const ua of [UA.chrome, UA.safari, UA.macApp, UA.iphone]) {
      expect(automatedClientOf({ 'user-agent': ua })).toBeUndefined();
      expect(automatedClientOf({ 'user-agent': ua }, '/ws?lean=x')).toBeUndefined();
    }
    expect(automatedClientOf(undefined)).toBeUndefined();
    expect(automatedClientOf({})).toBeUndefined();
  });

  it('navigator.webdriver, as the web app reports it on a call and on its socket', () => {
    expect(automatedClientOf({ [AUTOMATED_CLIENT_HEADER]: 'webdriver', 'user-agent': UA.chrome })).toBe('webdriver');
    expect(automatedClientOf({ 'user-agent': UA.safari }, `/ws?lean=x&${AUTOMATED_PARAM}=webdriver`)).toBe('webdriver');
    // A mark that says no is no mark.
    expect(automatedClientOf({ [AUTOMATED_CLIENT_HEADER]: '0' })).toBeUndefined();
    expect(automatedClientOf({}, '/ws?automated=false')).toBeUndefined();
    // The web app and the server name the same header and parameter.
    expect(AUTOMATED_HEADER).toBe(AUTOMATED_CLIENT_HEADER);
  });

  it('headless Chromium, read from its user agent even when it declares nothing (CDP)', () => {
    expect(automatedClientOf({ 'user-agent': UA.headless })).toBe('headless');
    expect(automatedClientOf({ 'user-agent': [UA.headless] }, '/ws')).toBe('headless');
  });

  it('the web app marks same-origin /api/ calls only, and only from an automated window', () => {
    const page = 'http://localhost:3456/tasks/x';
    const marked = initWithAutomated('/api/tasks', { method: 'POST' }, page, true);
    expect(new Headers(marked!.headers).get(AUTOMATED_HEADER)).toBe('webdriver');
    expect(marked!.method).toBe('POST');
    expect(initWithAutomated('/api/tasks', undefined, page, false)).toBeNull();
    expect(initWithAutomated('https://example.com/api/x', undefined, page, true)).toBeNull();
    expect(initWithAutomated('/assets/a.js', undefined, page, true)).toBeNull();
  });
});

describe('inside an automated client\'s scope nothing reads as the person', () => {
  // Every source the person types through, read from the source: a new one is covered or fails here.
  const personSources = [...PERSON_SEND_SOURCES, ...PERSON_START_SOURCES, ...PERSON_ONLY_SOURCES];

  it('outside the scope these are the person\'s', () => {
    expect(personSources.length).toBeGreaterThan(10);
    for (const s of personSources) expect(isPersonSource(s)).toBe(true);
    for (const s of personSources) expect(sendSourceOf(s)).toBe(s);
    expect(isPersonSource(AUTOMATED_SEND_SOURCE)).toBe(false);
    expect(ambientAutomatedClient()).toBeUndefined();
  });

  it('every person source is an agent\'s, and its text is framed as Walnut\'s naming the automation', () => {
    withAutomatedClient('webdriver', () => {
      for (const s of personSources) {
        expect(isPersonSource(s), s).toBe(false);
        expect(queueSentBy(s) ?? 'agent', s).toBe('agent');
        const framed = frameForSource('Video step: start a subagent', s);
        expect(readsAsPerson(framed), s).toBe(false);
        expect(framed).toContain('browser automation (webdriver)');
        expect(transcriptSentBy({ role: 'user', text: framed }), s).toBe('agent');
        const start = frameStartText('First line', { source: s });
        expect(readsAsPerson(start), s).toBe(false);
      }
      for (const s of PERSON_SEND_SOURCES) expect(isPersonSendSource(s)).toBe(false);
      // The source itself goes on as an agent's, so what reads it after the request is over agrees.
      for (const s of personSources) expect(sendSourceOf(s), s).toBe(AUTOMATED_SEND_SOURCE);
      for (const s of ['peer', 'walnut-notify', 'api-agent', 'routine-trigger']) expect(sendSourceOf(s)).toBe(s);
      // A start a person's composer emits as attributed is framed by the runner instead.
      const start = attributedUnlessAutomated('ui:typed-message');
      expect(start.attributed).toBeUndefined();
      expect(readsAsPerson(frameStartData({ message: 'Start it', ...start }).message!)).toBe(false);
      // Its own source, not `api-agent`: phase.ts once counted that one as a person's send.
      expect(routeSource('ui', {})).toBe(AUTOMATED_SEND_SOURCE);
      expect(isPhasePersonSend(routeSource('mobile', {}))).toBe(false);
      for (const s of PERSON_SEND_SOURCES) expect(isPhasePersonSend(s), s).toBe(false);
      expect(startRouteSource('quick-start', {})).toBe('automation:browser automation (webdriver)');
    });
  });

  it('the scope ends with its request: the person\'s next words are his again', () => {
    let open = true;
    withAutomatedClient('headless', () => {
      expect(queueSentBy('ui')).toBe('agent');
      open = false;
      expect(queueSentBy('ui')).toBe('person');
      expect(frameForSource('mine', 'ui')).toBe('mine');
    }, () => open);
    expect(routeSource('ui', {})).toBe('ui');
    expect(isPersonSendSource('ui')).toBe(true);
    expect(isPhasePersonSend('ui')).toBe(true);
    // A task calling a person's route is no person either.
    expect(isPhasePersonSend(routeSource('ui', { 'x-walnut-caller-sid': 'abc' }))).toBe(false);
    expect(attributedUnlessAutomated('ui:typed-message')).toEqual({ attributed: true, attributionSource: 'ui:typed-message' });
  });

  it('is on for the user\'s own install only, and the flag overrides it', async () => {
    expect(await automatedClientIsAgent({ WALNUT_AUTOMATED_CLIENT_AGENT: '1' })).toBe(true);
    expect(await automatedClientIsAgent({ WALNUT_AUTOMATED_CLIENT_AGENT: '0' })).toBe(false);
    // The test runner is a throwaway server: the automation stands in for the person there.
    expect(await automatedClientIsAgent({ VITEST: 'true' })).toBe(false);
  });
});

describe('ratchet: who a person is gets decided through the rule', () => {
  function walk(dir: string, out: string[] = []): string[] {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, out);
      else if (p.endsWith('.ts')) out.push(p);
    }
    return out;
  }

  it('no file reads the raw person set except the rule and the one held-notice check', () => {
    // The raw set answers "is this source a person's" without the automated-client scope.
    const allowed: Record<string, number> = {
      'src/core/sessions/send-sent-by.ts': 7,
      // A person's source from automation is still a message to act on, never a notice held for later.
      'src/core/session-message-queue.ts': 1,
    };
    const found: Record<string, number> = {};
    for (const f of walk(path.join(ROOT, 'src'))) {
      const n = (fs.readFileSync(f, 'utf8').match(/\b(PERSON_SEND_SOURCES|PERSON_START_SOURCES|PERSON_ONLY_SOURCES)\.has\(/g) ?? []).length;
      if (n) found[path.relative(ROOT, f)] = n;
    }
    expect(found).toEqual(allowed);
  });

  it('every hardcoded "a person sent this" is listed with why it holds for an automated browser too', () => {
    // A literal person sender skips the source rule. Each one here is either downgraded centrally
    // inside an automated client's scope or carries text framed for its source before it.
    const allowed: Record<string, number> = {
      'src/core/hints/hint-send.ts': 1,              // prepareStartHints: checks ambientAutomatedClient
      'src/core/org/thread-follow.ts': 1,            // prepareHintedSend downgrades `person` in the scope
      'src/core/sessions/folder-gone.ts': 1,         // rows re-sent as stored, already framed
      'src/core/sessions/personal-ai-lane.ts': 2,    // lane-turn.ts framed the first line for its source
      'src/core/sessions/quick-start.ts': 1,         // frameStartText framed it for the rewritten source
      'src/core/sessions/send-frame.ts': 1,          // attributedUnlessAutomated itself
      'src/core/sessions/session-controls.ts': 1,    // only when isPersonSource(source)
      'src/core/sessions/session-lifecycle.ts': 1,   // the first message again, as stored
      'src/core/sessions/session-rewind.ts': 1,      // the earlier message again, as stored
      'src/core/sessions/side-thread-manager.ts': 2, // prepareHintedSend downgrades `person` in the scope
      'src/core/sessions/task-start.ts': 1,          // frameStartText framed it for the rewritten source
      'src/core/subagents/on-host.ts': 1,            // attributed to `subagent`, framed by its lane turn
      'src/providers/daemon-connection.ts': 1,       // the phone's message relayed by the companion (no browser)
      'src/web/routes/session-chat.ts': 1,           // prepareHintedSend downgrades `person` in the scope
      'src/web/routes/sessions.ts': 1,               // execute-plan: generated text, framed separately
    };
    const found: Record<string, number> = {};
    for (const f of walk(path.join(ROOT, 'src'))) {
      const n = (fs.readFileSync(f, 'utf8').match(/sentBy: 'person'|attributed: true/g) ?? []).length;
      if (n) found[path.relative(ROOT, f)] = n;
    }
    expect(found).toEqual(allowed);
  });

  it('every control request Walnut sends the CLI is listed with the lines it makes the CLI file', () => {
    // 2026-11-16: an agent's model switch (apply_flag_settings) made the CLI file "/model
    // claude-sonnet-5-5" with no origin, and every transcript read it as the person typing it. Each
    // control request is read from the source (a request object names its subtype first; an event
    // or answer names its type first) and must be listed in CONTROL_REQUESTS, whose lines read as
    // nobody's words (tests/core/sessions/walnut-commands-ratchet.test.ts). A new one fails here
    // until it says what, if anything, it makes the CLI write into the transcript.
    // The CLI's question to Walnut, and Walnut's answer to one (`control_response`): no request.
    const fromCli = new Set(['can_use_tool', 'success']);
    const sent = new Set<string>();
    for (const f of walk(path.join(ROOT, 'src'))) {
      for (const m of fs.readFileSync(f, 'utf8').matchAll(/\{\s*subtype:\s*'([a-z_]+)'/g)) if (!fromCli.has(m[1]!)) sent.add(m[1]!);
    }
    expect([...sent].sort()).toEqual(Object.keys(CONTROL_REQUESTS).sort());
    for (const [kind, k] of Object.entries(CONTROL_REQUESTS)) expect(k.why.length, kind).toBeGreaterThan(5);
  });
});
