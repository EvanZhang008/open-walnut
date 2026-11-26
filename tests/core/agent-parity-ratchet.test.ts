/**
 * Every human action is an agent action too (AGENTS.md, "Every human action is an agent action
 * too"; 2026-10-27, the user: "all human action can be done by agent also"). A route or op that
 * refuses a session caller for being one is a door only a person has. The refusals left are the
 * team charter's approval rules (outward sends, spending, credentials, permissions, deleting cloud
 * resources or data) and two brakes, each listed here with its reason.
 *
 * A new refusal fails this test. Let the agent through and record who did it (`by`), or, for a
 * new approval rule, list it here with its charter category.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const SRC = path.join(ROOT, 'src');

/** A refusal's code or its message ("Only the user ...", "... is the user's to change"), as a string literal. */
const MARKER = /['"`](?:human_only|person_at_this_machine|human-approval-required|own_session|out_of_reach)['"`]|['"`]Only (?:the user|a human|a person|you, at this computer)\b|user\\?'s to change/g;

/** A file's code without its comments: a comment that names a refusal refuses nothing. */
function code(file: string): string {
  return fs.readFileSync(file, 'utf8').split('\n').filter((line) => !/^\s*(?:\/\/|\/\*|\*)/.test(line)).join('\n');
}

/** Codes retired by the rule: a session may do these now, so none may come back. */
const RETIRED = /['"`](?:main_session|own_lead|not_your_memory|not_author|not_in_team)['"`]/g;

/** A retired code still used for something else, by file: how many uses, and what for. */
const RETIRED_ELSEWHERE: Record<string, { uses: number; why: string }> = {
  'src/core/boards/board-kanban.ts': { uses: 1, why: 'a 404 for a card id that is not on the board\'s team, not a refusal of the caller' },
};

/** Every refusal left, by file: how many markers it holds, and the approval rule or brake it keeps. */
const APPROVAL_RULES: Record<string, { markers: number; rule: string }> = {
  'src/web/routes/browser-pair.ts': { markers: 2, rule: 'credentials: signing a browser in to this Walnut' },
  'src/web/routes/expose.ts': { markers: 2, rule: 'permissions: turning a tunnel on, how Walnut is reached from outside' },
  'src/web/routes/config.ts': { markers: 9, rule: 'permissions: config.expose (reach from outside), config.hosts (hosts that run a Walnut server), config.approvals (whether agents\' steps wait for the person: a session cannot turn its own asking off), config.leader_switch (the machines a switch starts commands on and the witnesses that grant the write permission), and outward sends: config.backup where the data home is uploaded' },
  'src/web/routes/backup-encrypted.ts': { markers: 1, rule: 'credentials and outward sends: the Google sign-in, the recovery key, and where backups are read from or restored to' },
  'src/web/routes/host-servers.ts': { markers: 2, rule: 'permissions: setting up a Walnut server on a host' },
  'src/web/routes/companion-build.ts': { markers: 2, rule: 'permissions: how the cloud companion installs new builds' },
  'src/web/routes/replicas-status.ts': { markers: 2, rule: 'deleting data: confirming a replica\'s removal of most of its rows' },
  'src/web/routes/engine-sign-in.ts': { markers: 2, rule: 'credentials: an engine CLI\'s API key (setting or removing it) and signing its account out on a host are the user\'s own; an agent may still start or finish a sign-in, since only the person has the code it needs' },
  'src/web/routes/secrets-v1.ts': { markers: 2, rule: 'credentials: adding, rotating, sharing or deleting a secret (core/secrets/fleet-secrets.ts)' },
  'src/web/routes/host-exec-v1.ts': { markers: 3, rule: 'permissions: granting or revoking a task\'s commands on another host, and a host\'s hard stop (a task\'s own Allow on its grant letter is ignored too, core/hosts/exec-grants.ts); a daemon update refuses only a caller that is neither a session (which goes under its host_exec grant) nor the person at this computer' },
  'src/integrations/mail/routes.ts': { markers: 1, rule: 'credentials and deleting data: removing a mail account deletes its stored password, its cache and its mail-to-task links (mail/agent-caller.ts personAct)' },
  'src/integrations/mail/sort-unsub-batch.ts': { markers: 1, rule: 'outward: a batch of unsubscribes runs the ladder on the console\'s authority (one rung sends mail); an agent asks per list with mail_unsubscribe_request, or runs the batch while approvals are off' },
  'src/integrations/mail/routes-invite.ts': { markers: 1, rule: 'outward: answering a meeting invite sends a reply in the user\'s name to its organizer, and no op asks the person about one, so an agent goes ahead only while approvals are off (mail/agent-caller.ts personActOrApprovalsOff); an agent still reads the invite, framed as untrusted data' },
  'src/integrations/calendar/routes.ts': { markers: 3, rule: 'outward: changing a calendar event Walnut did not make (others see it) needs the user\'s yes on the Mac' },
  'src/integrations/calendar/service.ts': { markers: 2, rule: 'outward: the same protected calendar write, refused when it cannot be confirmed' },
  'src/integrations/calendar/mail-calendars.ts': { markers: 1, rule: 'credentials: sending a mail account\'s password to a calendar server Walnut found needs the person at the Mac to approve that host' },
  'src/integrations/calendar/sign-in/routes.ts': { markers: 1, rule: 'credentials: setting, replacing or removing the OAuth client a mail account\'s calendar sign-in uses needs the person at the Mac' },
  'src/integrations/calendar/source-set.ts': { markers: 1, rule: 'outward: the same protected calendar write; its refusal is read as about one event, never the source' },
  'src/core/calendar/sources/eventkit.ts': { markers: 2, rule: 'outward: the macOS confirmation dialog for that write' },
  'src/ops/task-lifecycle.ts': { markers: 3, rule: 'permissions: a session changing its own permission mode; and the brake of session-control-guard.ts (a session stopping or restarting itself), asked here too for an older server' },
  'src/web/routes/human-inbox-v1.ts': { markers: 1, rule: 'outward: a plugin\'s letter asks the user to approve a step outside Walnut (a mail send, an unsubscribe), and its answer runs that step; and outward or irreversible: a task\'s answer for the user that approves rewriting history, unpublishing, deleting, publishing or sending, spending, credentials or permissions needs the user\'s quoted words naming that step (core/human-inbox/answer-approval.ts; 2026-10-29, "clear everything" became a history rewrite). Both checked in core/human-inbox/letter-ops.ts, so the replica\'s relay meets them too; any other answer goes through on the user\'s quoted words, recorded as the task\'s' },
  'src/web/routes/tasks.ts': { markers: 1, rule: 'deleting data: a session on another host merges only its own work (a merge deletes rows and their synced twins)' },
  'src/web/routes/vault-v1.ts': { markers: 2, rule: 'credentials: opening the password vault (core/vault/): only the master password buys a vault session; agents use an item only through their own ops, each use approved by the person' },
  'src/web/routes/browser-v1.ts': { markers: 2, rule: 'permissions: which sites agents may use in the person\'s own browser (any site, or the ones approved, and removing one); agents act in it through the browser op, and a new site is the person\'s approval' },
  'src/web/routes/browser-view-v1.ts': { markers: 9, rule: 'credentials: the live Browser view\'s frames and the Browser replay\'s recorded step pictures (2026-11-14) are not masked (a password a page shows as text shows in them), so they are the person\'s; an agent takes screenshot, which draws a shown password as dots. Its Stop is the person\'s too (review 2026-11-07: any session could name any task there and stop its work); an agent gives its own tab back with close. Take over and Hand back are the person\'s own hands on the tab: Take over brings the agent window to the front, which only the person\'s click may do (2026-11-08, the user: "don\'t steal person\'s browser focus"); an agent asks them with request_sign_in. Open in Chrome (2026-11-17) brings the task\'s tab and its window to the front the same way, so it is the person\'s click too; an agent names the window and tab in its answer instead.' },
  'src/web/routes/vault-agent-v1.ts': { markers: 2, rule: 'permissions: what agents may use from the password vault (the switch, ending grants) and the sealed log of their uses; an agent asks for an item through its ops and the person approves each use' },
  'src/web/routes/vault-sync-v1.ts': { markers: 3, rule: 'credentials: reading or removing the Mac keychain\'s copy of the master password (the keychain unlock itself has no route: Walnut uses it at start and in the daily sync), and handing Walnut a Bitwarden export, which writes and trashes vault items, only from a person\'s unlocked window; an agent asks Walnut to run bw itself (password_sync_bitwarden), refused only while agent access is Off' },
  'src/web/routes/approvals-v1.ts': { markers: 2, rule: 'permissions: answering an approval (`walnut approve`, core/approvals/) with a tap on any device the person is signed in on; the approval IS the person\'s yes, so no op answers one, and neither a session nor a browser under automation on the person\'s install may' },
  'src/web/routes/topics-v1.ts': { markers: 2, rule: 'outward: confirming a person an agent added to a topic, after which Walnut mails them outside Walnut, and choosing the mailbox a topic emails from, which sends in the user\'s name; a session may add the person and read the choice, only the user\'s own yes confirms them or picks the mailbox (core/topics/topic-post.ts confirmMember, chooseTopicMail). One refusal (personOnly) serves both, and the user\'s own words: a caller with no session that is not a person (a script, a browser under automation on his install, routes/person-caller.ts) is never the topic\'s "user" author, since his words are mailed out and acted on; a session always posts as its own task' },
  'src/core/sessions/session-control-guard.ts': { markers: 2, rule: 'brake: a session stopping or restarting itself would cut off its own turn' },
  'src/web/routes/vault-notes-v1.ts': { markers: 2, rule: 'credentials: a locked note is sealed with the Passwords master password, so reading, saving, locking or unlocking one, and restoring its key, needs the person\'s vault session (2026-11-24, the user: "only huamn can edit it, or ai can also do it wiht my password"); an agent reads or edits one through its ask, which the person approves with the master password' },
  'src/web/routes/hidden-notes-v1.ts': { markers: 2, rule: 'permissions: hiding a note from every agent tool, or unhiding it, is the person\'s own choice of what agents may read (2026-11-25, the user: a hidden note is plain text that no tool may use)' },
};

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    // Shipped skills and templates are prose for agents, not code paths.
    if (entry.isDirectory()) { if (full !== path.join(SRC, 'data')) out.push(...sourceFiles(full)); continue; }
    if (/\.(?:ts|tsx|js|mjs|cjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe('no door only a person has', () => {
  const files = sourceFiles(SRC);

  it('every refusal of a session caller left is an approval rule listed here', () => {
    const found: Record<string, number> = {};
    for (const file of files) {
      const n = (code(file).match(MARKER) ?? []).length;
      if (n) found[path.relative(ROOT, file)] = n;
    }
    const unlisted = Object.entries(found)
      .filter(([file, n]) => APPROVAL_RULES[file]?.markers !== n)
      .map(([file, n]) => `${file}: ${n} refusal marker(s), ${APPROVAL_RULES[file]?.markers ?? 0} listed`);
    expect(unlisted, 'A new human-only refusal. Let the agent do it and record who did, or list a new approval rule here.').toEqual([]);
    // A listed rule that no longer refuses is taken off the list.
    const stale = Object.keys(APPROVAL_RULES).filter((file) => !found[file]);
    expect(stale).toEqual([]);
  });

  it('the retired refusals stay retired', () => {
    const back = files.flatMap((file) => {
      const rel = path.relative(ROOT, file);
      const hits = code(file).match(RETIRED) ?? [];
      return hits.length === RETIRED_ELSEWHERE[rel]?.uses ? [] : hits.map((hit) => `${rel}: ${hit}`);
    });
    expect(back).toEqual([]);
  });

  // 2026-10-27: Main could not read a letter by id to pass its options on; the routes were there,
  // with no op to name them. What a person does in the inbox has an op an agent finds in the catalog.
  it('every inbox action a person takes has an op', async () => {
    const { listOps } = await import('../../src/ops/index.js');
    const served = new Set(listOps().flatMap((op) => [...(op.bind ? [op.bind] : []), ...(op.routes ?? [])].map((r) => `${r.method} ${r.path.replace(/:[a-z_]+/g, ':id')}`)));
    const person = [
      'GET /human-inbox', 'GET /human-inbox/:id', 'POST /human-inbox/:id/read', 'POST /human-inbox/:id/pin',
      'POST /human-inbox/:id/archive', 'POST /human-inbox', 'POST /human-inbox/:id/reply',
      'POST /human-inbox/:id/answer', 'POST /human-inbox/:id/human-reply',
    ];
    expect(person.filter((route) => !served.has(route))).toEqual([]);
  });

  it('the rule rides the repo rules', () => {
    const rules = fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8');
    expect(rules).toContain('**Every human action is an agent action too**');
    expect(rules).toContain('tests/core/agent-parity-ratchet.test.ts');
  });
});
