/**
 * Regression lock: the dtach socket dir MUST be derived from LOG_DIR.
 *
 * Incident 2026-08-10. DTACH_SOCKET_DIR was a machine-global literal
 * ('/tmp/open-walnut-term') while the rest of the runtime tree was already
 * env-isolated per instance. The terminal orphan reaper's kill rule is:
 *
 *     socket in this dir whose sessionId is absent from MY session registry → kill
 *
 * So any second instance with an isolated (therefore empty) session registry
 * enumerated PRODUCTION's sockets, classified every one as an orphan, and
 * pkill'd them. A vitest server did exactly that 1.2s after boot and killed the
 * user's live terminal mid-keystroke ('[got signal 15 - dying]').
 *
 * The invariant that makes that impossible: socket dir and session registry are
 * isolated in LOCKSTEP. Both hang off the same runtime root, so an instance can
 * only ever see — and only ever kill — its own terminals. These tests fail if
 * anyone reintroduces a hardcoded path.
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { DTACH_SOCKET_DIR, LOG_DIR } from '../../../src/constants.js';
import { DTACH_SOCKET_DIR as SPAWN_DTACH_SOCKET_DIR } from '../../../src/web/terminal/spawn.js';

describe('DTACH_SOCKET_DIR isolation', () => {
  it('lives under LOG_DIR, so an isolated runtime dir isolates the sockets too', () => {
    expect(DTACH_SOCKET_DIR.startsWith(LOG_DIR + path.sep)).toBe(true);
  });

  it('is NOT the old machine-global literal', () => {
    // The exact path that let a test server kill production's terminals.
    expect(DTACH_SOCKET_DIR).not.toBe('/tmp/open-walnut-term');
  });

  it('moves with LOG_DIR rather than being a fixed /tmp path', () => {
    // Under the test harness LOG_DIR is redirected to a per-worker tmp dir
    // (tests/setup/runtime-dir-isolation.ts). If DTACH_SOCKET_DIR were still
    // hardcoded it would sit outside that dir — the whole bug.
    expect(path.dirname(DTACH_SOCKET_DIR)).toBe(LOG_DIR);
  });

  it('spawn.ts re-exports the constant instead of defining a second source of truth', () => {
    expect(SPAWN_DTACH_SOCKET_DIR).toBe(DTACH_SOCKET_DIR);
  });
});
