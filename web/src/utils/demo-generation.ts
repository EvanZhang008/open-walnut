import { firstSentence } from '@open-walnut/host-problem';

export function isDemoOrigin(): boolean {
  return typeof window !== 'undefined' && window.location?.hostname === '127.0.0.1' && window.location.port === '3458';
}

let pageGeneration: string | undefined;
let pageSignInCommand: string | null = null;

// The Demo's own sign-in line, inline, or its short form that runs the same line from the generation's
// script file (demo-sign-ins.ts writeDemoSignInScript); never a command that would run in the real home.
const DEMO_SIGN_IN_SCRIPT = /^\/bin\/sh '\/(?:[^']|'\\'')*\/demo-sign-in\.sh'$/;

function usableSignInCommand(value: unknown): string | null {
  return typeof value === 'string' && value.length <= 16_384
    && (value.startsWith('/usr/bin/env -i HOME=') || DEMO_SIGN_IN_SCRIPT.test(value))
    && !/[\u0000-\u001f\u007f]/.test(value) ? value : null;
}

export async function initDemoGeneration(): Promise<boolean> {
  if (!isDemoOrigin()) return false;
  const response = await fetch('/api/demo/generation', { cache: 'no-store', signal: AbortSignal.timeout(10_000) });
  if (response.status === 404) return false;
  if (!response.ok) throw new Error('Demo could not confirm its data generation. Reload to try again.');
  const value = await response.json() as { generation?: unknown; signInCommand?: unknown };
  if (typeof value.generation !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(value.generation)) {
    throw new Error('Demo did not report a valid data generation.');
  }
  if (pageGeneration !== undefined) return pageGeneration !== value.generation;
  pageGeneration = value.generation;
  pageSignInCommand = usableSignInCommand(value.signInCommand);
  const key = 'walnut.demo.generation';
  const keptLocal = localStorage.getItem(key);
  const keptSession = sessionStorage.getItem(key);
  const changed = keptLocal !== value.generation;
  if (changed) { localStorage.clear(); localStorage.setItem(key, value.generation); }
  if (keptSession !== value.generation) {
    sessionStorage.clear(); sessionStorage.setItem(key, value.generation);
  }
  // A page of an earlier generation (a reset with the page open reloads it here) also carries that
  // generation's sessions and task in its address (`?s1=`, `?task=`, `/sessions?id=`), which no
  // storage clear reaches: the new first run would open them as "Session not found" columns.
  if ((keptLocal !== null && changed) || (keptSession !== null && keptSession !== value.generation)) dropEarlierAddress();
  return changed;
}

/** The address of a page from an earlier Demo generation names what that generation held: go to Home. */
export function dropEarlierAddress(): void {
  const loc = window.location;
  if (loc.pathname === '/' && !loc.search && !loc.hash) return;
  try { window.history?.replaceState?.(null, '', '/'); } catch { /* the page still opens on its old address */ }
}

// Null off a confirmed Demo page; `command: null` on one means show none, never the normal command.
export function demoSignInCopy(): { command: string | null } | null {
  if (!isDemoOrigin() || pageGeneration === undefined) return null;
  return { command: pageSignInCommand };
}

export const DEMO_SIGN_IN_UNAVAILABLE = 'Walnut Demo could not prepare its own sign-in command, so none is shown. Reload Walnut Demo to try again.';
export const DEMO_HOST_SIGN_IN = 'Walnut Demo shows no sign-in command here. For this computer, use Sign in to Claude Code on the Walnut Demo home; for a remote host, sign in from a terminal on that host.';
export const DEMO_HOST_SIGN_IN_UNCONFIRMED = 'Walnut could not confirm sign-in on this Demo host. Return to Walnut Demo to sign in, then Check again.';
export const DEMO_HOST_CLAUDE_ONE_CLICK = 'Walnut Demo shows no install or update command for your terminal, which would change your real Claude Code. Use Install Claude Code or Update Claude Code in Walnut Demo.';
export const DEMO_HOST_NO_COMMAND = 'Walnut Demo shows no command for your terminal, since it would run on your real home, not Walnut Demo. Fix it from Walnut Demo itself, or reset Walnut Demo.';

export type DemoCommandCopy = { kind: 'normal' } | { kind: 'note'; note: string };
const SIGN_IN_COMMANDS = new Set(['claude', 'claude auth login']);
const CLAUDE_TOOL = /\bclaude\b|claude-code|claude\.ai/i;

// Host rows do not know their host, so on Demo they copy nothing; `demo` is demoSignInCopy().
export function demoCommandCopyFor(demo: { command: string | null } | null, commands: readonly string[]): DemoCommandCopy {
  const list = commands.filter((c) => typeof c === 'string' && c.trim()).map((c) => c.trim());
  if (!demo || list.length === 0) return { kind: 'normal' };
  if (list.some((c) => SIGN_IN_COMMANDS.has(c))) return { kind: 'note', note: DEMO_HOST_SIGN_IN };
  return { kind: 'note', note: list.some((c) => CLAUDE_TOOL.test(c)) ? DEMO_HOST_CLAUDE_ONE_CLICK : DEMO_HOST_NO_COMMAND };
}

export function demoCommandCopy(commands: readonly string[]): DemoCommandCopy {
  return demoCommandCopyFor(demoSignInCopy(), commands);
}

// The message's later sentences name the commands Demo no longer shows, so only its state sentence stays.
export function demoHostMessageFor(demo: { command: string | null } | null, message: string, commands: readonly string[]): string {
  if (demoCommandCopyFor(demo, commands).kind === 'normal') return message;
  return firstSentence(message);
}

export function demoHostMessage(message: string, commands: readonly string[]): string {
  return demoHostMessageFor(demoSignInCopy(), message, commands);
}

export function demoPageGeneration(): string | undefined {
  return isDemoOrigin() ? pageGeneration : undefined;
}

export function demoDatabaseName(name: string): string {
  if (!isDemoOrigin()) return name;
  const generation = pageGeneration ?? localStorage.getItem('walnut.demo.generation');
  return generation && /^[a-zA-Z0-9-]{1,64}$/.test(generation) ? `${name}-demo-${generation}` : name;
}

export function installDemoGenerationFetch(): void {
  if (!isDemoOrigin()) return;
  const generation = pageGeneration ?? localStorage.getItem('walnut.demo.generation');
  if (!generation) return;
  const original = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
    if (url.origin !== window.location.origin || !url.pathname.startsWith('/api/')) return original(input, init);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.set('x-walnut-demo-generation', generation);
    return original(input, { ...init, headers });
  };
  const beacon = navigator.sendBeacon.bind(navigator);
  navigator.sendBeacon = (input, data) => {
    const url = new URL(String(input), window.location.href);
    if (url.origin !== window.location.origin || !url.pathname.startsWith('/api/')) return beacon(input, data);
    try {
      void original(input, {
        method: 'POST', body: data, keepalive: true,
        headers: { 'x-walnut-demo-generation': generation },
      }).catch(() => {});
      return true;
    } catch {
      return false;
    }
  };
}
