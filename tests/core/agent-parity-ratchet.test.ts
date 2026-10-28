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
  'src/web/routes/config.ts': { markers: 4, rule: 'permissions: config.expose (reach from outside) and config.hosts (hosts that run a Walnut server)' },
  'src/web/routes/host-servers.ts': { markers: 2, rule: 'permissions: setting up a Walnut server on a host' },
  'src/web/routes/companion-build.ts': { markers: 2, rule: 'permissions: how the cloud companion installs new builds' },
  'src/web/routes/replicas-status.ts': { markers: 2, rule: 'deleting data: confirming a replica\'s removal of most of its rows' },
  'src/integrations/calendar/routes.ts': { markers: 3, rule: 'outward: changing a calendar event Walnut did not make (others see it) needs the user\'s yes on the Mac' },
  'src/integrations/calendar/service.ts': { markers: 3, rule: 'outward: the same protected calendar write, refused when it cannot be confirmed' },
  'src/core/calendar/sources/eventkit.ts': { markers: 2, rule: 'outward: the macOS confirmation dialog for that write' },
  'src/ops/task-lifecycle.ts': { markers: 2, rule: 'permissions: a session changing its own permission mode' },
  'src/web/routes/tasks.ts': { markers: 1, rule: 'deleting data: a session on another host merges only its own work (a merge deletes rows and their synced twins)' },
  'src/core/sessions/session-control-guard.ts': { markers: 2, rule: 'brake: a session stopping or restarting itself would cut off its own turn' },
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

  it('the rule rides the repo rules', () => {
    const rules = fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8');
    expect(rules).toContain('**Every human action is an agent action too**');
    expect(rules).toContain('tests/core/agent-parity-ratchet.test.ts');
  });
});
