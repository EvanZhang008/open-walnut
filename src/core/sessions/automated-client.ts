/**
 * A browser under automation is never the user (2026-11-16: a task recording a proof video drove
 * headless Chromium with Playwright on the user's own Walnut and typed into another task's
 * composer twice; both rows read `sentBy: "person"`, the one word every agent trusts as the user's,
 * and the "the user is using this task" guard then held that task's completion).
 *
 * Who is automated, decided per request or per socket from what only automation has:
 *
 * - `navigator.webdriver === true`, which the web app reports as `x-walnut-automated: webdriver` on
 *   its `/api/` calls and `?automated=webdriver` on its socket (web/src/api/test-run.ts). The
 *   WebDriver spec makes a browser set it when automation controls it: Playwright's launches
 *   (tests/e2e/browser/automated-client-sender.spec.ts checks Chromium and WebKit), Puppeteer's
 *   launch, Selenium and chromedriver. A browser a person
 *   opens (Chrome, Safari, the Mac app's web view, a browser on the phone) never sets it, and a
 *   page cannot turn it on by itself. `?walnut-test-run=0` turns a window's test run off, never this.
 * - A `HeadlessChrome/` user agent, read by the server itself: headless Chromium attached over CDP
 *   (`connectOverCDP`, a raw DevTools client), where `navigator.webdriver` can be false. No browser
 *   a person uses has a window-less build that says so.
 *
 * Not covered, by design: CDP attached to a person's own headed Chrome. The `walnut browser`
 * extension, the one way agents drive the user's Chrome, refuses Walnut's own pages
 * (packages/browser-extension/src/agent-shared.ts, `walnut_page`).
 *
 * What it changes: while a request or socket call from an automated client runs, every person
 * source reads as an agent's (send-sent-by.ts) and its text is framed as Walnut's (send-frame.ts),
 * so nothing it sends passes as the user's word, answers his permission prompt or marks a task as
 * one he is using. Only on the user's own install (`automatedClientIsAgent`): on a throwaway server
 * (an ephemeral Walnut, the test fixtures) the automation stands in for the person on purpose, and
 * proof videos that type are recorded there. `WALNUT_AUTOMATED_CLIENT_AGENT=1` turns it on there
 * (this rule's own tests), `=0` off anywhere.
 *
 * Dependency-free at import (send-sent-by.ts imports it).
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export const AUTOMATED_CLIENT_HEADER = 'x-walnut-automated';
/** The socket's query parameter: browsers cannot set a header on a WebSocket. */
export const AUTOMATED_CLIENT_PARAM = 'automated';

export type AutomatedClientKind = 'webdriver' | 'headless';

type HeaderBag = Record<string, string | string[] | undefined>;

function first(v: string | string[] | null | undefined): string {
  return ((Array.isArray(v) ? v[0] : v) ?? '').trim().toLowerCase();
}

/** A declared mark counts unless it says no: any value but empty, `0` or `false`. */
function declared(v: string): boolean {
  return v !== '' && v !== '0' && v !== 'false';
}

/** Pure: whether a request (its headers, and for a socket its URL) comes from a browser under automation. */
export function automatedClientOf(headers: HeaderBag | undefined, url?: string): AutomatedClientKind | undefined {
  if (declared(first(headers?.[AUTOMATED_CLIENT_HEADER]))) return 'webdriver';
  if (url) {
    try {
      if (declared(first(new URL(url, 'http://ws.local').searchParams.get(AUTOMATED_CLIENT_PARAM)))) return 'webdriver';
    } catch { /* an unreadable URL declares nothing */ }
  }
  const ua = (Array.isArray(headers?.['user-agent']) ? headers?.['user-agent'][0] : headers?.['user-agent']) ?? '';
  if (/\bHeadlessChrome\//.test(ua)) return 'headless';
  return undefined;
}

/** The sender an automated client's framed text names (send-frame.ts). */
export function automatedClientLabel(kind: AutomatedClientKind): string {
  return kind === 'headless' ? 'browser automation (headless browser)' : 'browser automation (webdriver)';
}

interface Scope { kind: AutomatedClientKind; live: () => boolean }
const ambient = new AsyncLocalStorage<Scope>();

/**
 * Run `fn` as an automated client's work (no scope when `kind` is undefined). `live` says whether the
 * request is still open, as for a test run (test-run.ts withTestRun): a timer it leaves armed does
 * later work that is not the request's.
 */
export function withAutomatedClient<T>(kind: AutomatedClientKind | undefined, fn: () => T, live: () => boolean = () => true): T {
  return kind ? ambient.run({ kind, live }, fn) : fn();
}

/** The automated client the current request or socket call comes from, while it is open. */
export function ambientAutomatedClient(): AutomatedClientKind | undefined {
  const s = ambient.getStore();
  return s && s.live() ? s.kind : undefined;
}

/** Whether this server attributes an automated client's input to an agent (see the file comment). */
export async function automatedClientIsAgent(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const flag = env.WALNUT_AUTOMATED_CLIENT_AGENT;
  if (flag === '1') return true;
  if (flag === '0') return false;
  const { isRealInstall } = await import('../test-run.js');
  return isRealInstall(env);
}
