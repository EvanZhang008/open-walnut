/**
 * Signal-call ratchet: the server never signals a pid it read from the
 * sessions store.
 *
 * 2026-09-26: an ephemeral test server holding a hand-copied production
 * sessions store SIGTERM'd the user's live CLIs from its orphan sweep, and a
 * gate review later found five more paths (idle reap, capacity eviction, task
 * completion, terminate, the runner's sweep) that signalled record pids the same
 * way. Every one now asks the owning daemon (src/core/sessions/owner-stop.ts).
 * This test keeps it that way, like event-loop-blocking-ratchet.test.ts does for
 * sync child_process calls.
 *
 * Three tiers, all over the TypeScript AST. Comments never count, and string
 * contents count only in tier 3:
 *
 *  1. RAW signals: `process.kill(pid, sig)` with any signal but the literal 0
 *     (0 is an existence probe), a bare `kill(...)`, and the group helpers
 *     `safeKillProcessGroup` / `killProcessGroup` / `signalProcessGroup`. They
 *     may only appear in the files below that signal a process they spawned
 *     themselves, at most as often as listed. Everywhere else: zero.
 *  2. SESSION-STORE code (the files that read session records): every
 *     kill-shaped call at all, `.kill(` on any object included, is counted
 *     against a per-file budget. The existing ones are session-manager RPCs
 *     (`mgr.kill('idle')` sends the daemon a `stop`) and the owner sweeps.
 *  3. SIGNALS THE CALL SHAPES ABOVE CANNOT SEE: shell text in a string or
 *     template literal that sends a signal (`pkill`, `killall`, `kill` with a
 *     pid or any flag but `-0`, a bare 'kill' command name), `process['kill']`,
 *     and `process.kill` taken as a value (`const k = process.kill`,
 *     `.bind`, `{ kill } = process`, an import of `kill` from 'process',
 *     `globalThis.process.kill(...)`). Budgeted per file in INDIRECT_SIGNAL_BUDGET.
 *
 * What none of the tiers can see: a signal whose command text is assembled
 * from pieces that are not literals (e.g. `[verb, pid].join(' ')` with `verb`
 * computed at runtime), and a signal sent by a program the server runs whose
 * own source is not under src/. Review those by hand.
 *
 * The daemon twins are exempt: the daemon owns its CLI processes and checks
 * their identity before it signals (daemon-standalone.ts stopSessionProcess).
 *
 * Adding a site fails with instructions. Removing one? Lower the number: the
 * ratchet only tightens. DO NOT raise a number to make a record pid killable:
 * end the process through its daemon instead (stopThroughOwner,
 * sweepOrphansThroughOwner, stopAcpThroughOwner).
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const repoRoot = path.resolve(__dirname, '../..');

/** The daemon owns its processes and proves their identity before any signal. */
const EXEMPT = new Set([
  'src/providers/daemon-standalone.ts',
  'src/providers/daemon-source.ts',
]);

/**
 * Files that signal processes THEY spawned (a child, their own daemon, their
 * own server), with the number of raw signal sites each may have.
 */
const RAW_SIGNAL_BUDGET: Record<string, number> = {
  'src/commands/web.ts': 1,                        // the ephemeral child it launched, on a failed launch
  'src/core/cloud-setup/providers/aws.ts': 2,      // its own CLI child's group, on timeout
  'src/core/cloud-setup/providers/cli-exec.ts': 3, // same
  'src/core/plugin-npm-install.ts': 1,             // its own npm child's group
  'src/core/process-group-kill.ts': 1,             // safeKillProcessGroup itself (refuses pid <= 1)
  'src/core/time-tracking/outside-collector.ts': 1,// its own collector child's group
  'src/integrations/git-bundle-client.ts': 1,      // its own git child's group
  'src/integrations/git-sync.ts': 2,               // its own git children's groups
  'src/providers/acp-daemon.ts': 7,                // ACP workers the daemon spawned
  'src/providers/claude-check-core.ts': 3,         // its own probe child (a process.kill wrapper + its two calls)
  'src/providers/host-fix-core.ts': 3,             // its own fix-script child (a process.kill wrapper + its two calls)
  'src/providers/local-daemon.ts': 1,              // an ISOLATED daemon it manages (refuses the production dir)
  'src/providers/trigger-check-core.ts': 1,        // its own check-script child's group
  'src/providers/vscode-server-core.ts': 2,        // the editor server it launched
  'src/web/routes/git-http.ts': 1,                 // its own git child's group
  'src/web/server.ts': 1,                          // re-raises a fatal signal on itself
};

/** Code that reads session records: every kill-shaped call is budgeted here. */
function isSessionStoreFile(rel: string): boolean {
  return /^src\/core\/session-[^/]*\.ts$/.test(rel)
    || rel.startsWith('src/core/sessions/')
    || /^src\/providers\/(claude-code-session|remote-session-manager|session-[^/]*)\.ts$/.test(rel)
    || /^src\/web\/routes\/sessions[^/]*\.ts$/.test(rel);
}

const SESSION_STORE_BUDGET: Record<string, number> = {
  // this.killOrphanedProcesses (the owner sweep) + mgr.kill('idle') (daemon RPC)
  'src/core/session-health-monitor.ts': 2,
  // mgr.kill() on a registered session manager (daemon RPC)
  'src/core/sessions/session-lifecycle.ts': 1,
  // the transport's and live sessions' kill() (daemon RPCs) + the owner sweep
  'src/providers/claude-code-session.ts': 5,
  // its own host-probe child
  'src/providers/session-host.ts': 1,
  // retiring a live plan session (ClaudeCodeSession.kill: daemon RPC)
  'src/web/routes/sessions.ts': 1,
};

/**
 * Tier 3 sites allowed per file: shell signals in command text, and indirect
 * uses of process.kill. Each one ends a process the file itself launched and
 * identified.
 */
const INDIRECT_SIGNAL_BUDGET: Record<string, number> = {
  // `kill -TERM "$PID"` on the daemon in its own dir, after `ps` proved the pid's command and start time
  'src/providers/daemon-start-cmd.ts': 1,
  // `pkill -f <socket>` on this Walnut's own dtach terminal master (the socket dir's owner marker gates the sweep)
  'src/web/terminal/dtach-lifecycle.ts': 1,
  // `pkill -f " -A <runtimeDir>/term/walnut-"`: the dtach masters of an ephemeral server whose runtime dir is being deleted
  'src/commands/ephemeral-registry.ts': 1,
};

const RAW_HELPERS = new Set(['safeKillProcessGroup', 'killProcessGroup', 'signalProcessGroup']);

/** Shell text that sends a signal. `kill -0` is an existence probe and does not count. */
const SHELL_SIGNAL = /\b(?:pkill|killall)\b|\bkill\s+(?!-0\b)[-$"'`(%\d]/;
/** A literal that ends in a kill command whose pid is concatenated on: `'kill -9 ' + pid`. */
const SHELL_SIGNAL_TAIL = /\bkill\s+(?:(?!-0\b)-[-A-Za-z0-9]*\s+)?$/;
/** A literal that is only the command name, as in spawn('kill', [pid]). */
const KILL_COMMAND = /^(?:\/(?:usr\/)?bin\/)?(?:kill|pkill|killall)$/;

/** `process`, `globalThis.process` or `global.process` (not a field named process, like a child handle). */
function isProcessObject(node: ts.Expression): boolean {
  if (ts.isIdentifier(node)) return node.text === 'process';
  return ts.isPropertyAccessExpression(node) && node.name.text === 'process'
    && ts.isIdentifier(node.expression) && (node.expression.text === 'globalThis' || node.expression.text === 'global');
}

/** Tier 3: shell signals in literals and process.kill used any way but a direct call. */
export function findIndirectSignalSites(fileName: string, text: string): string[] {
  const out: string[] = [];
  if (!/kill/i.test(text)) return out;
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.ES2022, true);
  const at = (node: ts.Node, what: string) => {
    out.push(`${fileName}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1} ${what}`);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      // The key of `obj['kill']` is a property name, not a command (the element access is judged below).
      const isKey = ts.isElementAccessExpression(node.parent) && node.parent.argumentExpression === node;
      if (!isKey && (SHELL_SIGNAL.test(node.text) || SHELL_SIGNAL_TAIL.test(node.text) || KILL_COMMAND.test(node.text))) at(node, 'shell signal');
    } else if (ts.isTemplateExpression(node)) {
      // Each substitution stands in as `$`, so `kill ${pid}` reads as `kill $`.
      const whole = node.head.text + node.templateSpans.map((s) => '$' + s.literal.text).join('');
      if (SHELL_SIGNAL.test(whole)) at(node, 'shell signal');
    } else if (ts.isElementAccessExpression(node) && isProcessObject(node.expression)) {
      const key = node.argumentExpression;
      if ((ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key)) && key.text === 'kill') at(node, "process['kill']");
    } else if (ts.isPropertyAccessExpression(node) && node.name.text === 'kill' && isProcessObject(node.expression)) {
      const directCall = ts.isCallExpression(node.parent) && node.parent.expression === node;
      // A direct `process.kill(...)` belongs to tier 1; `globalThis.process.kill(...)` is its blind spot.
      if (!directCall) at(node, 'process.kill as a value');
      else if (!ts.isIdentifier(node.expression)) at(node, `${node.expression.getText(sf)}.kill(`);
    } else if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name)
        && node.initializer && isProcessObject(node.initializer)) {
      for (const el of node.name.elements) {
        const key = el.propertyName ?? el.name;
        if ((ts.isIdentifier(key) || ts.isStringLiteral(key)) && key.text === 'kill') at(el, '{ kill } = process');
      }
    } else if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)
        && /^(?:node:)?process$/.test(node.moduleSpecifier.text)) {
      const named = node.importClause?.namedBindings;
      if (named && ts.isNamedImports(named)) {
        for (const el of named.elements) {
          if ((el.propertyName ?? el.name).text === 'kill') at(el, "import { kill } from 'process'");
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

function isKillShaped(name: string): boolean {
  // `kill`, `killTree`, `safeKillProcessGroup`, `signalProcessGroup`; not `skill`, `sweepKilledGcPacks`.
  return name === 'kill' || /^kill[A-Z]/.test(name) || /[a-z]Kill[A-Z]/.test(name) || name === 'signalProcessGroup';
}

function isZeroLiteral(node: ts.Expression | undefined): boolean {
  return !!node && ts.isNumericLiteral(node) && node.text === '0';
}

export interface SignalSites { raw: string[]; killShaped: string[] }

/** Every raw signal site and every kill-shaped call site in one file's text. */
export function findSignalSites(fileName: string, text: string): SignalSites {
  const sites: SignalSites = { raw: [], killShaped: [] };
  if (!/kill|signalProcessGroup/i.test(text)) return sites;
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.ES2022, true);
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee) ? callee.text
        : ts.isPropertyAccessExpression(callee) ? callee.name.text
          : null;
      if (name && isKillShaped(name)) {
        const isProcessKill = ts.isPropertyAccessExpression(callee)
          && ts.isIdentifier(callee.expression) && callee.expression.text === 'process' && name === 'kill';
        const probe = isProcessKill
          ? isZeroLiteral(node.arguments[1])
          : name === 'kill' && node.arguments.length === 1 && isZeroLiteral(node.arguments[0]);
        if (!probe) {
          const where = `${fileName}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1} ${callee.getText(sf).replace(/\s+/g, '')}(`;
          sites.killShaped.push(where);
          if (isProcessKill || RAW_HELPERS.has(name) || (name === 'kill' && ts.isIdentifier(callee))) sites.raw.push(where);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return sites;
}

/** Every .ts file under src/, tracked or not (a new file must not slip past). */
function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(full);
    }
  };
  walk(path.join(repoRoot, 'src'));
  return out;
}

function scan(): { byFile: Map<string, SignalSites>; indirect: Map<string, string[]> } {
  const byFile = new Map<string, SignalSites>();
  const indirect = new Map<string, string[]>();
  for (const full of sourceFiles()) {
    const rel = path.relative(repoRoot, full).split(path.sep).join('/');
    if (EXEMPT.has(rel)) continue;
    const text = fs.readFileSync(full, 'utf8');
    const sites = findSignalSites(rel, text);
    if (sites.killShaped.length > 0) byFile.set(rel, sites);
    const hidden = findIndirectSignalSites(rel, text);
    if (hidden.length > 0) indirect.set(rel, hidden);
  }
  return { byFile, indirect };
}

describe('signal-call ratchet', () => {
  const { byFile, indirect } = scan();

  it('raw signals only appear where a file signals a process it spawned itself', () => {
    const violations: string[] = [];
    for (const [file, sites] of byFile) {
      const allowed = RAW_SIGNAL_BUDGET[file] ?? 0;
      if (sites.raw.length > allowed) {
        violations.push(
          `${file}: ${sites.raw.length} raw signal site(s), budget ${allowed}:\n    ${sites.raw.join('\n    ')}\n`
          + '  A pid read from the sessions store proves nothing about who owns the process '
          + '(2026-09-26: a test server killed the user\'s live CLIs this way). End a CLI through its daemon '
          + '(src/core/sessions/owner-stop.ts). Signalling a child THIS code spawned? Add it to RAW_SIGNAL_BUDGET with a reason.',
        );
      }
    }
    expect(violations, violations.join('\n\n')).toEqual([]);
  });

  it('session-store code gains no new kill-shaped call', () => {
    const violations: string[] = [];
    for (const [file, sites] of byFile) {
      if (!isSessionStoreFile(file)) continue;
      const allowed = SESSION_STORE_BUDGET[file] ?? 0;
      if (sites.killShaped.length > allowed) {
        violations.push(
          `${file}: ${sites.killShaped.length} kill-shaped call(s), budget ${allowed}:\n    ${sites.killShaped.join('\n    ')}\n`
          + '  Session-store code ends a CLI only through its daemon: stopThroughOwner, sweepOrphansThroughOwner, '
          + 'stopAcpThroughOwner, or a session manager RPC. Never a pid from a record.',
        );
      }
    }
    expect(violations, violations.join('\n\n')).toEqual([]);
  });

  it('no shell signal or indirect process.kill outside the files that end their own processes', () => {
    const violations: string[] = [];
    for (const [file, sites] of indirect) {
      const allowed = INDIRECT_SIGNAL_BUDGET[file] ?? 0;
      if (sites.length > allowed) {
        violations.push(
          `${file}: ${sites.length} indirect signal site(s), budget ${allowed}:\n    ${sites.join('\n    ')}\n`
          + '  A `kill`/`pkill` in a command, or process.kill reached any way but a direct call, is still a signal. '
          + 'End a CLI through its daemon (src/core/sessions/owner-stop.ts). Ending a process THIS code launched and '
          + 'identified? Add it to INDIRECT_SIGNAL_BUDGET with a reason.',
        );
      }
    }
    expect(violations, violations.join('\n\n')).toEqual([]);
  });

  it('budgets are still accurate (the ratchet only tightens)', () => {
    const stale: string[] = [];
    for (const [file, allowed] of Object.entries(INDIRECT_SIGNAL_BUDGET)) {
      const actual = indirect.get(file)?.length ?? 0;
      if (actual < allowed) stale.push(`${file}: INDIRECT_SIGNAL_BUDGET says ${allowed}, only ${actual} remain: lower it to ${actual}.`);
    }
    for (const [file, allowed] of Object.entries(RAW_SIGNAL_BUDGET)) {
      const actual = byFile.get(file)?.raw.length ?? 0;
      if (actual < allowed) stale.push(`${file}: RAW_SIGNAL_BUDGET says ${allowed}, only ${actual} remain: lower it to ${actual}.`);
    }
    for (const [file, allowed] of Object.entries(SESSION_STORE_BUDGET)) {
      const actual = byFile.get(file)?.killShaped.length ?? 0;
      if (actual < allowed) stale.push(`${file}: SESSION_STORE_BUDGET says ${allowed}, only ${actual} remain: lower it to ${actual}.`);
    }
    expect(stale, stale.join('\n')).toEqual([]);
  });

  it('the scan sees the session store at all (a broken walker would pass everything)', () => {
    expect(byFile.get('src/core/session-health-monitor.ts')?.killShaped.length).toBeGreaterThan(0);
    expect(byFile.get('src/core/process-group-kill.ts')?.raw.length).toBe(1);
    expect(isSessionStoreFile('src/core/session-tracker.ts')).toBe(true);
    expect(isSessionStoreFile('src/core/sessions/owner-stop.ts')).toBe(true);
    expect(indirect.get('src/providers/daemon-start-cmd.ts')).toHaveLength(1);
  });
});

describe('findSignalSites: what counts', () => {
  const sites = (code: string) => findSignalSites('x.ts', code);

  it('a signal to a record pid is raw, in every spelling', () => {
    expect(sites("process.kill(s.pid!, 'SIGTERM')").raw).toHaveLength(1);
    expect(sites('process.kill(-record.pid, "SIGKILL")').raw).toHaveLength(1);
    expect(sites('process.kill(pid)').raw).toHaveLength(1);
    expect(sites('process.kill(pid, sig)').raw).toHaveLength(1);
    expect(sites("safeKillProcessGroup(row.pid, 'SIGINT')").raw).toHaveLength(1);
    expect(sites("killProcessGroup(child)").raw).toHaveLength(1);
    expect(sites("signalProcessGroup(pid, 'SIGKILL')").raw).toHaveLength(1);
    expect(sites("kill(pid, 'SIGTERM')").raw).toHaveLength(1);
  });

  it('an existence probe, a comment, a string or a lookalike name is not a site', () => {
    expect(sites('process.kill(pid, 0)').killShaped).toEqual([]);
    expect(sites("// process.kill(s.pid, 'SIGTERM')\n/* safeKillProcessGroup(p) */").killShaped).toEqual([]);
    expect(sites("const s = \"process.kill(pid, 'SIGTERM')\"").killShaped).toEqual([]);
    expect(sites('skill(); getSkill(x); sweepKilledGcPacks()').killShaped).toEqual([]);
  });

  it('an object .kill is kill-shaped but not raw (a child or a session manager RPC)', () => {
    const s = sites("child.kill('SIGTERM'); mgr.kill('idle'); this.killOrphanedProcesses(rows)");
    expect(s.killShaped).toHaveLength(3);
    expect(s.raw).toEqual([]);
  });
});

describe('findIndirectSignalSites: what counts', () => {
  const sites = (code: string) => findIndirectSignalSites('x.ts', code);

  it('a signal in command text counts, however the command is written', () => {
    expect(sites("exec('pkill -f walnut.sock')")).toHaveLength(1);
    expect(sites("run('killall node')")).toHaveLength(1);
    expect(sites('run(`kill -9 ${pid}`)')).toHaveLength(1);
    expect(sites('run(`kill ${pid}`)')).toHaveLength(1);
    expect(sites("run('kill -TERM \"$PID\"')")).toHaveLength(1);
    expect(sites("run('kill $(cat daemon.pid)')")).toHaveLength(1);
    expect(sites("run('kill -- -' + pgid)")).toHaveLength(1);
    expect(sites("run('kill ' + pid)")).toHaveLength(1);
    expect(sites("run('kill -s TERM ' + pid)")).toHaveLength(1);
    expect(sites("spawn('kill', [String(pid)])")).toHaveLength(1);
    expect(sites("spawn('/bin/kill', ['-9', String(pid)])")).toHaveLength(1);
  });

  it('process.kill reached any way but a direct call counts', () => {
    expect(sites("process['kill'](pid, 'SIGTERM')")).toHaveLength(1);
    expect(sites('const k = process.kill; k(pid)')).toHaveLength(1);
    expect(sites('const k = process.kill.bind(process)')).toHaveLength(1);
    expect(sites('deps({ kill: process.kill })')).toHaveLength(1);
    expect(sites('const { kill } = process')).toHaveLength(1);
    expect(sites('const { kill: k } = globalThis.process')).toHaveLength(1);
    expect(sites("import { kill } from 'node:process'")).toHaveLength(1);
    expect(sites("globalThis.process.kill(pid, 'SIGTERM')")).toHaveLength(1);
  });

  it('an existence probe, prose, a comment or a direct call (tier 1) does not count here', () => {
    expect(sites("run('kill -0 \"$p\" 2>/dev/null && echo 1')")).toEqual([]);
    expect(sites('run(`[ -n "$P" ] && kill -0 ${pid}`)')).toEqual([]);
    expect(sites("log('could not kill the daemon'); log('skill killed nothing')")).toEqual([]);
    expect(sites('// run(`kill -9 ${pid}`)\n/* pkill -f x */')).toEqual([]);
    expect(sites("process.kill(pid, 'SIGTERM'); process.kill(pid, 0); child.kill('SIGTERM')")).toEqual([]);
    expect(sites("this.process.kill('SIGTERM'); const k = this.process.kill")).toEqual([]);
  });
});
