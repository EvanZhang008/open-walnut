/**
 * The whole environment a budget E2E gives the daemon it spawns: nothing is
 * inherited from the test process except the exec-guard markers, so no model
 * credential, proxy, socket, git or Walnut setting can reach the daemon or its
 * children, and every directory it may write lives under one scratch root.
 */
import os from 'node:os';
import path from 'node:path';
import { guardedPath } from '../../setup/exec-guard.js';

/** The only extra keys a budget E2E may add: its own fixture settings. */
const EXTRA_KEY = /^(BUDGET_FIXTURE_[A-Z_]+|MOCK_ACP_FAIL_LOAD_FILE|MOCK_ACP_WITNESS)$/;
/** Keys that would hand a child a real provider, account, proxy or repository. */
const CREDENTIAL_KEY = /^(AWS_|ANTHROPIC_|OPENAI_|CLAUDE_CODE_OAUTH|GOOGLE_|AZURE_|GIT_)|_API_KEY$|_TOKEN$|^(HTTPS?|ALL|NO)_PROXY$|^SSH_AUTH_SOCK$/i;

const inside = (child: string, parent: string) => {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

export function budgetDaemonEnv(root: string, opts: { walnutHome?: string; extra?: Record<string, string> } = {}): NodeJS.ProcessEnv {
  const home = path.join(root, 'home');
  // The Walnut data dir is the scratch root's own, or the budget E2E's mocked test home
  // (createMockConstants('session-budget-e2e'), directly under the temp dir) that holds the root.
  const walnutHome = opts.walnutHome ?? path.join(root, 'walnut-home');
  const mockedHome = path.dirname(walnutHome) === path.resolve(os.tmpdir()) && /^session-budget-e2e-\d+-[a-z0-9]+$/.test(path.basename(walnutHome))
    && inside(root, walnutHome);
  if (!inside(walnutHome, root) && !mockedHome) throw new Error(`Walnut home ${walnutHome} is neither inside the scratch root nor the mocked test home`);
  for (const key of Object.keys(opts.extra ?? {})) if (!EXTRA_KEY.test(key)) throw new Error(`Budget fixture env may not set ${key}`);
  const env: NodeJS.ProcessEnv = {
    PATH: guardedPath([path.dirname(process.execPath)], '/usr/bin:/bin:/usr/sbin:/sbin'),
    HOME: home, USERPROFILE: home, TMPDIR: path.join(root, 'tmp'), SHELL: '/bin/sh', LANG: 'C', LC_ALL: 'C',
    CLAUDE_CONFIG_DIR: path.join(home, 'config'), CODEX_HOME: path.join(home, 'codex'), XDG_DATA_HOME: path.join(home, 'data'),
    OPEN_WALNUT_HOME: walnutHome,
    // Nothing the daemon or a session would call back: a closed port.
    OPEN_WALNUT_API_URL: 'http://127.0.0.1:9', WALNUT_SERVER_URL: 'http://127.0.0.1:9',
    WALNUT_DAEMON_DIR: path.join(root, 'daemon'), WALNUT_STREAMS_DIR: path.join(root, 'streams'),
    WALNUT_LEGACY_STREAMS_DIR: path.join(root, 'no-legacy'), WALNUT_SPAWN_JOURNAL: path.join(root, 'journal.jsonl'),
    WALNUT_RESUME_RECORD_DIR: path.join(root, 'resume-records'),
    WALNUT_DAEMON_KEEP_SESSIONS: '1', WALNUT_TURN_RETRY_ENABLED: '0',
    ...opts.extra,
  };
  for (const key of Object.keys(env)) if (CREDENTIAL_KEY.test(key)) throw new Error(`Budget fixture env carries ${key}`);
  for (const key of ['HOME', 'TMPDIR', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'WALNUT_DAEMON_DIR', 'WALNUT_STREAMS_DIR', 'WALNUT_SPAWN_JOURNAL', 'WALNUT_RESUME_RECORD_DIR']) {
    if (!inside(env[key]!, root)) throw new Error(`${key} is outside the scratch root`);
  }
  return env;
}

/** fetch with a deadline: a hung local request fails the test instead of hanging it. */
export function fetchWithin(url: string, init: RequestInit = {}, ms = 15_000): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
}

/** The last bytes a child wrote to stderr, for the error a failed spawn throws. */
export function stderrTail(limit = 4_096) {
  let text = '';
  return { push(chunk: Buffer | string) { text = (text + String(chunk)).slice(-limit); }, get text() { return text; } };
}
