/**
 * The native calendar write gate (src/data/walnut-calendar.swift), checked without
 * a calendar and without a dialog.
 *
 * An update or delete passes on its own only for a Walnut block: stamped
 * openwalnut://calendar-block/<UUID> by `create`, no attendees, organizer none or
 * the user. Every other event, unstamped old blocks included, is refused with
 * `human-approval-required`, or with --human-confirm goes through a real AppKit
 * dialog that only a click on "… and notify" passes. A remove(.thisEvent) on one
 * occurrence of an invited Exchange series deleted the whole series and declined
 * it, which is what this gate exists for.
 *
 * Two layers, neither touching EventKit or the screen:
 *  - the source: the order of the checks in the dispatch, the single path to a
 *    dialog, its buttons, its clock, and the error codes the service maps;
 *  - the pure rules block (between its BEGIN/END markers), cut out, compiled on
 *    its own with a small harness and RUN, so the URL stamp test, the policy, the
 *    flag parsing and the messages are executed, not just read.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = fs.readFileSync(path.join(REPO, 'src', 'data', 'walnut-calendar.swift'), 'utf8');
const MAIN = SRC.slice(SRC.indexOf('func walnutCalendarMain'));
const FLAG = '--human-confirm';

/** The `{…}` body of `func <name>(`, by brace matching (no string here holds a brace). */
function funcBody(name: string): string {
  const start = SRC.indexOf(`func ${name}(`);
  if (start < 0) throw new Error(`no func ${name}`);
  const open = SRC.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}' && --depth === 0) return SRC.slice(open, i + 1);
  }
  throw new Error(`unbalanced func ${name}`);
}

/** One `case "<name>":` arm of the dispatch switch. */
function caseArm(name: string): string {
  const start = MAIN.indexOf(`\ncase "${name}":`);
  if (start < 0) throw new Error(`no case ${name}`);
  const next = MAIN.slice(start + 1).search(/\n(case "|default:)/);
  return MAIN.slice(start, start + 1 + next);
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function inOrder(haystack: string, ...needles: string[]): void {
  let at = -1;
  for (const n of needles) {
    const i = haystack.indexOf(n, at + 1);
    expect(i, `"${n}" after position ${at}`).toBeGreaterThan(at);
    at = i;
  }
}

describe('native write gate, in the source', () => {
  it('answers capabilities before the re-exec and before any Calendars request', () => {
    inOrder(MAIN, 'args[1] == "capabilities"', 'output(["writeSafetyVersion": writeSafetyVersion])', 'exit(0)',
      '\nreexecDisclaimedIfNeeded()', '\nrequestAccess()');
  });

  it('allows get, and still refuses an unknown subcommand before asking for access', () => {
    const allowed = /guard \[([^\]]+)\]\.contains\(args\[1\]\)/.exec(MAIN);
    expect(allowed).not.toBeNull();
    expect(allowed![1]!.split(',').map((s) => s.trim().replace(/"/g, ''))).toEqual(
      ['calendars', 'list', 'get', 'update', 'create', 'delete'],
    );
    inOrder(MAIN, 'unknown subcommand', '\nrequestAccess()', '\ncase "get":');
    expect(caseArm('get')).toContain('output(eventJson(findOccurrence(args[2])))');
  });

  it('stamps every created event before it is saved', () => {
    inOrder(caseArm('create'), 'event.url = newWalnutBlockURL()', 'store.save(');
  });

  it('gates update and delete on the exact occurrence before anything is written', () => {
    for (const [arm, write, action] of [['update', 'store.save(', '.update'], ['delete', 'store.remove(', '.delete']] as const) {
      const body = caseArm(arm);
      inOrder(body, 'splitHumanConfirm(', 'findOccurrence(', 'allowsContentModifications',
        `requireWriteApproval(event, ${action}, humanConfirm: parsed.humanConfirm`, write);
      // Nothing about the event changes before the gate has answered.
      const firstChange = body.search(/event\.\w+ = /);
      if (firstChange >= 0) expect(firstChange).toBeGreaterThan(body.indexOf('requireWriteApproval('));
    }
    expect(count(MAIN, 'requireWriteApproval(')).toBe(2);
  });

  it('resolves an occurrence exactly and never falls back to the series', () => {
    const body = funcBody('findOccurrence');
    expect(SRC).not.toContain('?? base');
    expect(SRC).not.toContain('findEvent(');
    // "abc#" must not collapse to the bare id.
    expect(body).toContain('omittingEmptySubsequences: false');
    // The only `return base` is the non-recurring bare id, after the recurring refusal.
    expect(count(body, 'return base')).toBe(1);
    inOrder(body, 'if parts.count == 1', 'base.hasRecurrenceRules || base.isDetached', 'code: "not-found"', 'return base');
    inOrder(body, 'guard let occurrence = store.events(matching: predicate).first(where:', 'code: "not-found"', 'return occurrence');
  });

  it('refuses a protected write without the flag, and the default path shows nothing', () => {
    const gate = funcBody('requireWriteApproval');
    inOrder(gate, 'if facts.writableWithoutHuman { return }', 'guard humanConfirm else',
      'fail(approvalRequiredMessage(action, facts), code: "human-approval-required")', 'confirmWithPerson(');
    expect(gate).not.toMatch(/NSAlert|NSApplication|runConfirmAlert/);
  });

  it('has exactly one path to a dialog: the flag on a protected event', () => {
    expect(count(SRC, 'NSAlert(')).toBe(1);
    expect(funcBody('runConfirmAlert')).toContain('NSAlert(');
    expect(count(SRC, 'NSApplication.shared')).toBe(count(funcBody('runConfirmAlert'), 'NSApplication.shared'));
    // runConfirmAlert is called only by confirmWithPerson, which only the gate calls.
    expect(count(SRC, 'runConfirmAlert(')).toBe(2); // definition + one call
    expect(funcBody('confirmWithPerson')).toContain('runConfirmAlert(');
    expect(count(SRC, 'confirmWithPerson(')).toBe(2);
    expect(funcBody('requireWriteApproval')).toContain('confirmWithPerson(');
  });

  it('makes Cancel the default button and only a click on the second button a yes', () => {
    const alert = funcBody('runConfirmAlert');
    inOrder(alert, 'alert.addButton(withTitle: "Cancel")', 'cancel.keyEquivalent = "\\r"',
      'alert.addButton(withTitle: confirmButton)', 'goAhead.keyEquivalent = ""');
    expect(count(alert, 'addButton(')).toBe(2);
    // The only road to .confirmed: the second button, then the caller and the clock re-checked.
    expect(count(alert, 'return .confirmed')).toBe(1);
    inOrder(alert, 'guard response == .alertSecondButtonReturn else { return .cancelled }',
      'if getppid() != caller { return .callerGone }', 'if Date() >= deadline { return .timedOut }', 'return .confirmed');
  });

  it('bounds the dialog by a deadline and by the caller staying alive', () => {
    const alert = funcBody('runConfirmAlert');
    inOrder(alert, 'Timer(', 'getppid() != caller', 'Date() >= deadline', 'abortModal()',
      'RunLoop.main.add(timer, forMode: .modalPanel)', 'alert.runModal()', 'timer.invalidate()');
    const budget = /private let humanConfirmBudget: TimeInterval = (\d+)/.exec(SRC);
    expect(Number(budget?.[1])).toBeGreaterThan(0);
    expect(Number(budget?.[1])).toBeLessThanOrEqual(90);
    // The caller is the parent as seen right after the re-exec.
    inOrder(MAIN, '\nreexecDisclaimedIfNeeded()', '\nlet caller = getppid()', '\nrequestAccess()');
  });

  it('ends every dialog outcome but the click without writing, with the codes the service maps', () => {
    const confirm = funcBody('confirmWithPerson');
    inOrder(confirm, 'case .confirmed:', 'return', 'case .cancelled:', 'code: "approval-canceled"',
      'case .timedOut, .callerGone:', 'code: "human-approval-required"');
    // A screen nobody can answer is refused before any dialog.
    inOrder(confirm, 'CGSessionCopyCurrentDictionary()', 'code: "human-approval-required"', 'runConfirmAlert(');
    const codes = new Set([...SRC.matchAll(/code: "([^"]+)"/g)].map((m) => m[1]));
    expect([...codes].sort()).toEqual(
      ['approval-canceled', 'human-approval-required', 'not-found', 'permission-denied', 'readonly', 'save-failed', 'usage'],
    );
  });

  it('reads no environment that could stand in for the click', () => {
    const reexec = funcBody('reexecDisclaimedIfNeeded');
    expect(count(SRC, 'environment')).toBe(count(reexec, 'environment'));
  });

  it('serializes the write-safety facts on every event, organizer fields only when there is one', () => {
    const json = funcBody('eventJson');
    for (const key of ['walnutCreated', 'hasAttendees', 'recurring', 'writeSafetyVersion']) {
      expect(json).toContain(`out["${key}"] =`);
    }
    expect(json).toContain('if let mine = facts.organizerIsCurrentUser { out["organizerIsCurrentUser"] = mine }');
    expect(json).toContain('if let name = facts.organizerName { out["organizerName"] = name }');
    const facts = funcBody('writeFacts');
    expect(facts).toContain('walnutCreated: isWalnutBlockURL(e.url)');
    expect(facts).toContain('recurring: e.hasRecurrenceRules || e.isDetached');
  });
});

// ── the pure rules, compiled and executed ──────────────────────────────────

const hasSwift = process.platform === 'darwin'
  && spawnSync('xcrun', ['--find', 'swiftc'], { encoding: 'utf8' }).status === 0;

const BEGIN = '// BEGIN pure write-safety rules';
const END = '// END pure write-safety rules';
const PURE = SRC.slice(SRC.indexOf(BEGIN), SRC.indexOf(END));

const HARNESS = `
import Foundation
${PURE}
let input = try! JSONSerialization.jsonObject(with: FileHandle.standardInput.readDataToEndOfFile()) as! [String: Any]
var out: [String: Any] = [
    "writeSafetyVersion": writeSafetyVersion,
    "humanConfirmBudget": humanConfirmBudget,
    "humanConfirmFlag": humanConfirmFlag,
]
let stamp = newWalnutBlockURL()
out["stamp"] = stamp.absoluteString
out["stampIsBlock"] = isWalnutBlockURL(stamp)
out["nilIsBlock"] = isWalnutBlockURL(nil)
out["urls"] = (input["urls"] as! [String]).map { s -> Any in
    guard let u = URL(string: s) else { return NSNull() }
    return isWalnutBlockURL(u)
}
out["splits"] = (input["splits"] as! [[String: Any]]).map { c -> Any in
    guard let r = splitHumanConfirm(c["args"] as! [String], required: c["required"] as! Int, optional: c["optional"] as! Int) else { return NSNull() }
    return ["positional": r.positional, "humanConfirm": r.humanConfirm] as [String: Any]
}
out["facts"] = (input["facts"] as! [[String: Any]]).map { c -> Any in
    let f = WriteFacts(
        title: c["title"] as! String,
        walnutCreated: c["walnutCreated"] as! Bool,
        hasAttendees: c["hasAttendees"] as! Bool,
        organizerIsCurrentUser: c["organizerIsCurrentUser"] as? Bool,
        organizerName: c["organizerName"] as? String,
        recurring: c["recurring"] as! Bool
    )
    var r: [String: Any] = ["writableWithoutHuman": f.writableWithoutHuman]
    for (key, action) in [("update", WriteAction.update), ("delete", WriteAction.delete)] {
        r[key] = [
            "refusal": approvalRequiredMessage(action, f),
            "alertTitle": confirmAlertTitle(action, f),
            "alertText": confirmAlertText(action, f, when: "WHEN-LINE"),
            "confirmButton": action.confirmButton,
        ]
    }
    return r
}
FileHandle.standardOutput.write(try! JSONSerialization.data(withJSONObject: out))
`;

const UUID = '0F8C6B5E-3A0D-4C49-9E3B-6A0A9E7D2F11';
const URLS: Array<[string, boolean]> = [
  [`openwalnut://calendar-block/${UUID}`, true],
  [`openwalnut://calendar-block/${UUID.toLowerCase()}`, true],
  [`https://calendar-block/${UUID}`, false],
  [`openwalnut://calendar/${UUID}`, false],
  ['openwalnut://calendar-block/', false],
  ['openwalnut://calendar-block', false],
  ['openwalnut://calendar-block/not-a-uuid', false],
  [`openwalnut://calendar-block/${UUID}/extra`, false],
  [`openwalnut://calendar-block/${UUID}/`, false],
  [`openwalnut://calendar-block/${UUID}?x=1`, false],
  [`openwalnut://calendar-block/${UUID}#part`, false],
  [`openwalnut://someone@calendar-block/${UUID}`, false],
  [`openwalnut://calendar-block:80/${UUID}`, false],
  ['https://meet.example.com/abc', false],
  ['mailto:organizer@example.com', false],
];

type Split = { args: string[]; required: number; optional: number; want: { positional: string[]; humanConfirm: boolean } | null };
const U = (args: string[], want: Split['want']): Split => ({ args, required: 3, optional: 1, want });
const D = (args: string[], want: Split['want']): Split => ({ args, required: 1, optional: 0, want });
const ID = 'EV1#1760000000', S = '2026-10-12T10:00:00', E = '2026-10-12T11:00:00';
const SPLITS: Split[] = [
  U([ID, S, E], { positional: [ID, S, E], humanConfirm: false }),
  U([ID, S, E, 'Focus'], { positional: [ID, S, E, 'Focus'], humanConfirm: false }),
  // The flag in the title slot is the flag, never a title.
  U([ID, S, E, FLAG], { positional: [ID, S, E], humanConfirm: true }),
  U([ID, S, E, 'Focus', FLAG], { positional: [ID, S, E, 'Focus'], humanConfirm: true }),
  U([ID, S, E, '', FLAG], { positional: [ID, S, E, ''], humanConfirm: true }),
  U([ID, S, E, FLAG, 'Focus'], null),
  U([ID, S, E, FLAG, FLAG], null),
  U([ID, FLAG, S, E], null),
  U([ID, S, E, 'Focus', 'extra'], null),
  U([ID, S], null),
  D([ID], { positional: [ID], humanConfirm: false }),
  D([ID, FLAG], { positional: [ID], humanConfirm: true }),
  D([FLAG], null),
  D([], null),
  D([ID, 'extra'], null),
  D([ID, FLAG, FLAG], null),
];

type Facts = { title: string; walnutCreated: boolean; hasAttendees: boolean; organizerIsCurrentUser: boolean | null; organizerName: string | null; recurring: boolean };
const MATRIX: Facts[] = [];
for (const walnutCreated of [true, false]) {
  for (const hasAttendees of [true, false]) {
    for (const organizerIsCurrentUser of [null, true, false]) {
      MATRIX.push({ title: 'Block', walnutCreated, hasAttendees, organizerIsCurrentUser, organizerName: null, recurring: false });
    }
  }
}
/** The incident's shape: an invitation to a recurring Exchange meeting. */
const INVITED_SERIES: Facts = {
  title: 'Weekly sync', walnutCreated: false, hasAttendees: true, organizerIsCurrentUser: false, organizerName: 'Alice', recurring: true,
};
/** A block made before the stamp existed: looks personal, still protected. */
const OLD_BLOCK: Facts = {
  title: 'Deep work', walnutCreated: false, hasAttendees: false, organizerIsCurrentUser: null, organizerName: null, recurring: false,
};
const FACTS = [...MATRIX, INVITED_SERIES, OLD_BLOCK];

type Result = {
  writeSafetyVersion: number; humanConfirmBudget: number; humanConfirmFlag: string;
  stamp: string; stampIsBlock: boolean; nilIsBlock: boolean;
  urls: Array<boolean | null>;
  splits: Array<{ positional: string[]; humanConfirm: boolean } | null>;
  facts: Array<{ writableWithoutHuman: boolean } & Record<'update' | 'delete', { refusal: string; alertTitle: string; alertText: string; confirmButton: string }>>;
};

describe.skipIf(!hasSwift)('pure write-safety rules, compiled and run', () => {
  let result: Result;

  beforeAll(() => {
    expect(PURE.length).toBeGreaterThan(BEGIN.length);
    // The block must stand alone: nothing from EventKit, AppKit or the store.
    expect(PURE).not.toMatch(/\bEK[A-Z]|\bNS[A-Z]|\bstore\.|import /);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-calendar-write-policy-'));
    try {
      const main = path.join(dir, 'main.swift');
      const exe = path.join(dir, 'policy');
      fs.writeFileSync(main, HARNESS);
      const built = spawnSync('xcrun', ['swiftc', '-o', exe, main], { encoding: 'utf8', timeout: 300_000 });
      if (built.status !== 0) throw new Error(`swiftc failed:\n${built.stderr}`);
      const input = JSON.stringify({ urls: URLS.map(([u]) => u), splits: SPLITS, facts: FACTS });
      const ran = spawnSync(exe, [], { input, encoding: 'utf8', timeout: 30_000 });
      if (ran.status !== 0) throw new Error(`policy harness failed:\n${ran.stderr}`);
      result = JSON.parse(ran.stdout) as Result;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 300_000);

  it('reports the contract version and a dialog budget inside the server timeout', () => {
    expect(result.writeSafetyVersion).toBe(1);
    expect(result.humanConfirmFlag).toBe(FLAG);
    expect(result.humanConfirmBudget).toBeGreaterThan(0);
    expect(result.humanConfirmBudget).toBeLessThanOrEqual(90);
  });

  it('stamps openwalnut://calendar-block/<UUID> and recognizes only that', () => {
    expect(result.stamp).toMatch(/^openwalnut:\/\/calendar-block\/[0-9A-F-]{36}$/);
    expect(result.stampIsBlock).toBe(true);
    expect(result.nilIsBlock).toBe(false);
    URLS.forEach(([url, want], i) => expect(result.urls[i], url).toBe(want));
  });

  it('lets a write through alone only for a stamped event nobody else is on', () => {
    MATRIX.forEach((f, i) => {
      const want = f.walnutCreated && !f.hasAttendees && f.organizerIsCurrentUser !== false;
      expect(result.facts[i]!.writableWithoutHuman, JSON.stringify(f)).toBe(want);
    });
    expect(result.facts[FACTS.indexOf(INVITED_SERIES)]!.writableWithoutHuman).toBe(false);
    expect(result.facts[FACTS.indexOf(OLD_BLOCK)]!.writableWithoutHuman).toBe(false);
  });

  it('reads the flag only as the trailing argument, never as a title', () => {
    SPLITS.forEach((c, i) => expect(result.splits[i], JSON.stringify(c.args)).toEqual(c.want));
  });

  it('refuses the invited series by name, with the series, the organizer and Hide event', () => {
    const r = result.facts[FACTS.indexOf(INVITED_SERIES)]!;
    expect(r.delete.refusal).toBe(
      'Delete "Weekly sync" needs a person to confirm it on this Mac: Walnut did not create it, it has attendees and Alice organizes it.'
      + ' It is one occurrence of a recurring series, and the calendar server may apply this to the whole series.'
      + ' The organizer (Alice) may be notified.'
      + ' Use Hide event instead to remove it from Walnut without changing the calendar.',
    );
    expect(r.update.refusal).toMatch(/^Update "Weekly sync" needs a person/);
  });

  it('refuses an old unstamped block too, without claiming a series', () => {
    const r = result.facts[FACTS.indexOf(OLD_BLOCK)]!;
    expect(r.delete.refusal).toContain('Delete "Deep work" needs a person to confirm it on this Mac: Walnut did not create it.');
    expect(r.delete.refusal).not.toContain('recurring series');
    expect(r.delete.refusal).toContain('The organizer may be notified.');
    expect(r.delete.refusal).toContain('Use Hide event instead');
  });

  it('words the dialog as the action, the series risk, the organizer, and Hide event', () => {
    const r = result.facts[FACTS.indexOf(INVITED_SERIES)]!;
    expect(r.delete.alertTitle).toBe('Delete "Weekly sync"?');
    expect(r.update.alertTitle).toBe('Update "Weekly sync"?');
    expect(r.delete.confirmButton).toBe('Delete and notify');
    expect(r.update.confirmButton).toBe('Update and notify');
    const text = r.delete.alertText;
    inOrder(text, 'WHEN-LINE', 'Walnut did not create it', 'recurring series', 'whole series',
      'The organizer (Alice) may be notified', 'decline', 'Hide event');
    expect(r.update.alertText).toContain('whole series');
    expect(r.update.alertText).toContain('The organizer (Alice) and the attendees may be notified');
    // Even a one-off event's dialog carries the series warning and the hide advice.
    const once = result.facts[FACTS.indexOf(OLD_BLOCK)]!.delete.alertText;
    expect(once).toContain('whole series');
    expect(once).toContain('Hide event');
  });
});
