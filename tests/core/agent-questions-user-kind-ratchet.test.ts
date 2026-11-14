import { describe, expect, it } from 'vitest';
import { USER_KINDS } from '../../src/core/org/user-kind.js';
import { readStatusReport } from '../../src/core/session-hooks/builtins.js';
import { deriveUserStatus } from '../../src/core/user-status.js';
import { TEAM_CHARTER } from '../../src/core/team-charter.js';

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
  it('teaches all tasks to fetch through owners and check action attribution first', () => {
    expect(TEAM_CHARTER).toContain('Missing tools never mean the user runs commands or pastes logs');
    expect(TEAM_CHARTER).toContain('security_alert_check');
    expect(TEAM_CHARTER).toContain('unknown goes to the owner or lead');
  });
});
