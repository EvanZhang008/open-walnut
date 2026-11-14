import { describe, expect, it } from 'vitest';
import { USER_KINDS } from '../../src/core/org/user-kind.js';
import { readStatusReport } from '../../src/core/session-hooks/builtins.js';
import { deriveUserStatus } from '../../src/core/user-status.js';
import { TEAM_CHARTER } from '../../src/core/team-charter.js';
import { readFileSync } from 'node:fs';

const now = Date.now();
describe('every task keeps agent questions off the user', () => {
  for (const kind of [undefined, 'technical', 'logs', 'account_check', 'agent_info', 'convenience']) {
    it(`a ${String(kind)} ask goes to the lead, never Needs you`, () => {
      const report = readStatusReport(`FOR_USER_STATE: needs-you\nFOR_USER_ASK: Fetch the failed CI logs.\n${kind ? `FOR_USER_ASK_OWN: ${kind}: The agent can fetch this readable information.` : ''}`, new Date(now))!;
      expect(report).toMatchObject({ state: 'waiting', waiting_kind: 'lead', kindless_ask: true });
      expect(report).not.toHaveProperty('ask');
      const status = deriveUserStatus({ phase: 'WAITING', hasSession: true, processStatus: 'stopped', hasLeader: true,
        phaseChangedAt: new Date(now - 120_000).toISOString(), report }, now + 60_000);
      expect(status.state).not.toBe('needs');
    });
  }
  // Enumerate the source registry so newly added kinds remain explicit, not accidental defaults.
  for (const kind of USER_KINDS) {
    it(`the ${kind} decision needs an explicit kind and reason`, () => {
      expect(readStatusReport(`FOR_USER_STATE: needs-you\nFOR_USER_ASK: Decide this protected step.\nFOR_USER_ASK_OWN: ${kind}: This protected step requires the person's decision.`, new Date(now)))
        .toMatchObject({ state: 'needs', ask_own: { kind } });
    });
  }
  it('keeps owner escalation in the bootstrap and action details in the on-demand guide', () => {
    expect(TEAM_CHARTER).toContain('goes to the task that owns it or to your lead, not to the user');
    expect(TEAM_CHARTER).not.toContain('security_alert_check');
    const guide = readFileSync(new URL('../../src/data/skills/walnut-session-messaging/SKILL.md', import.meta.url), 'utf8');
    expect(guide).toContain('Missing tools never mean the user runs commands or pastes logs');
    expect(guide).toContain('`security_alert_check`');
    expect(guide).toContain('unknown goes to the owner or lead');
  });
});
