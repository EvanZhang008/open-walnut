// Every way new mail enters the cache reaches the mailbox's router (2026-11-12: the Personal router
// read no mail at all, because an arrival entered its area only through a confirmed rule).
// The behaviour itself is pinned in mail-router-intake.test.ts ("a mailbox bound to its router").
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(rel));
    else if (/\.(ts|tsx|mjs|js)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(rel);
  }
  return out;
}

/** Each call site of `name(` in src, as `file:enclosing function`. */
function callSites(name: string): string[] {
  const sites: string[] = [];
  for (const file of sourceFiles('src')) {
    const text = read(file);
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      if (!line.includes(`.${name}(`) || /^\s*(\/\/|\*)/.test(line)) return;
      let fn = '?';
      for (let at = i; at >= 0; at -= 1) {
        const m = /^\s*(?:export\s+)?(?:async\s+)?(?:private\s+|public\s+)?(?:async\s+)?(?:function\s+)?([A-Za-z_]\w*)\s*\(/.exec(lines[at])
          ?? /^\s*const\s+([A-Za-z_]\w*)\s*=\s*(?:async\s*)?\(/.exec(lines[at]);
        if (m && !['if', 'for', 'while', 'switch', 'catch', 'return'].includes(m[1])) { fn = m[1]; break; }
      }
      sites.push(`${file}:${fn}`);
    });
  }
  return sites.sort();
}

// Every place a mail row is written from a provider's listing, and how its arrival reaches the router.
const INGEST_SITES: Record<string, string> = {
  // The poll: its headlines go through captureIncoming (router-intake.ts) before the arrival event.
  'src/integrations/mail/sync.ts:syncContainer': 'poll: arrivals are announced after the router intake',
  // The unread refresh hands the mail it cached first to the router intake (sync.routeArrivals).
  'src/integrations/mail/service.ts:runUnreadCheck': 'unread refresh: new rows go to the router intake',
};

describe('every new mail reaches its mailbox router', () => {
  it('each ingest of a provider listing is a known path that hands arrivals to the router intake', () => {
    const sites = callSites('ingestPage');
    expect(sites, 'A new path writes mail rows from a provider. Send its arrivals through captureIncoming '
      + '(src/integrations/mail/router-intake.ts) or write only rows already cached, then list it here.')
      .toEqual(Object.keys(INGEST_SITES).sort());
  });

  it('the unread refresh hands the mail it cached first to the router intake', () => {
    const service = read('src/integrations/mail/service.ts');
    expect(service).toMatch(/const ingested = await this\.ingestPage\(accountId, mine\)\n[\s\S]{0,400}this\.deps\.arrivals\(accountId, ingested\.headlines\)/);
    expect(read('src/integrations/mail/index.ts')).toMatch(/arrivals: \(accountId, headlines\) => sync \? sync\.routeArrivals\(accountId, headlines\)/);
    expect(read('src/integrations/mail/sync.ts')).toMatch(/async routeArrivals\([\s\S]{0,300}await this\.captureIncoming\(accountId, headlines, opts\)[\s\S]{0,120}await this\.finishIncoming\(accountId, finish\)/);
  });

  it('the one arrival event runs after the router intake, and the plugin wires the intake and the mailbox binding', () => {
    expect(callSites('messagesReceived')).toEqual(['src/integrations/mail/sync.ts:announce']);
    const sync = read('src/integrations/mail/sync.ts');
    const capture = sync.indexOf('const finish = deferred ? await this.captureIncoming(accountId, headlines) : null');
    expect(capture).toBeGreaterThan(0);
    // A failed intake announces the mail as ingested (null), never as nothing.
    expect(sync.indexOf('announce(finish ? await this.finishIncoming(accountId, finish) : null)')).toBeGreaterThan(capture);
    // Other folders' arrivals reach the intake too, never announced, routed only when the router watches that folder.
    expect(sync).toMatch(/if \(announcing && otherHeadlines\.length > 0\) await this\.routeArrivals\(accountId, otherHeadlines, \{ inbox: false \}\)/);
    // Only the plugin's MailService wiring (pinned above) and the poll's other folders hand arrivals to the intake.
    expect(callSites('routeArrivals').map((site) => site.split(':')[0])).toEqual(['src/integrations/mail/index.ts', 'src/integrations/mail/sync.ts']);
    const index = read('src/integrations/mail/index.ts');
    expect(index).toMatch(/const captureIncoming = createMailRouterIntake\(/);
    expect(index).toMatch(/new MailSync\(\{[^}]*captureIncoming[^}]*\}\)/);
    // What the intake could not enter yet is retried every tick (router-intake.ts retry).
    expect(index).toMatch(/new MailSync\(\{[^}]*retryIncoming: captureIncoming\.retry[^}]*\}\)/);
    expect(index).toMatch(/bindMailAccounts\(store, routingHome/);
    const intake = read('src/integrations/mail/router-intake.ts');
    // Every arrival in a folder the bound router watches goes to that router; nothing else decides first.
    expect(intake).toMatch(/if \(!watchesFolder\(folders, mailbox\)\) continue/);
    expect(intake).toMatch(/await confirmAccount\(batch\.map\(/);
    expect(intake).toMatch(/await ensure\(accountId\)/);
  });
});
